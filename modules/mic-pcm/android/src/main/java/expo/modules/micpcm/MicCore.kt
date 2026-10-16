// Android microphone capture for modules/mic-pcm (P3 spike, SPEC §5, D12, D16). Process-wide singleton, so the
// microphone foreground service (MicCaptureService) and the JS module share one capture.
// AudioRecord with UNPROCESSED (if PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED is set) → VOICE_RECOGNITION → MIC,
// built-in mic preferred, 48 kHz (44.1 fallback), PCM_FLOAT (PCM_16 → float fallback), AGC/NS/AEC switched off where
// the platform attaches them. Loop structure adapted from expo-audio's AudioStream.kt (MIT, © 650 Industries / Expo);
// timing, ring buffer, silencing detection, FGS and the dev-only synthetic source are new.
// Timing contract (src/MicPcm.types.ts PcmChunk): AudioRecord.getTimestamp(TIMEBASE_MONOTONIC) gives the capture time
// of a known frame; the first frame of each read is extrapolated from it on the device sample clock and converted to
// epoch ms with ONE offset taken at start(). PCM stays in memory (ring buffer) and is never written anywhere (D13).
package expo.modules.micpcm

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.AudioTimestamp
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.os.SystemClock
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.jni.NativeArrayBuffer
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.max

class MicException(code: String, message: String) : CodedException(code, message, null)

/**
 * AudioSource constants of android.media (MIC 1, VOICE_RECOGNITION 6, UNPROCESSED 9). Spelled out so this module never names
 * the file-writing recorder class at all: the A12 scan (src/no-audio.test.ts) forbids it.
 */
private object AudioSourceId {
  const val MIC = 1
  const val VOICE_RECOGNITION = 6
  const val UNPROCESSED = 9
}

object MicCore {
  var module: MicPcmModule? = null
  private val lock = Object()

  private var record: AudioRecord? = null
  private var thread: Thread? = null
  @Volatile private var running = false
  private var startedAtMs: Double? = null
  private var epochOffsetMs = 0.0
  private var rate = 48000.0
  private var bufferFrames = 4800
  private var ring = PcmRing(48000 * 10)
  private var sourceName = "voice_recognition"
  private var processed = false
  private var pendingDisc = true
  private var background = false
  private var appContext: Context? = null

  private var readCursor = 0L
  private var pushCursor = 0L
  private var pushEnabled = false
  private var inFlight = 0
  private const val MAX_IN_FLIGHT = 4
  private var pushThread: HandlerThread? = null
  private var pushHandler: Handler? = null
  private var pushScratch = FloatArray(48000)

  private var synth: Synth? = null
  private var synthSpec: Map<String, Any?>? = null
  private var synthIndex = 0L
  private var synthStartMono = 0.0
  private var inject = FloatArray(0)
  private var injectPos = 0
  @Volatile private var debugSilenced = false

  private var silenced = false
  private var recordingCallback: AudioManager.AudioRecordingCallback? = null
  private val cbExecutor = Executors.newSingleThreadExecutor()

  // statistics for the spike
  private var st = Stats()

  class Stats {
    var callbacks = 0
    var frames = 0L
    var minFrames = Int.MAX_VALUE
    var maxFrames = 0
    var tsOk = 0
    var tsFallback = 0
    var maxTsStepErrMs = 0.0
    var pushEvents = 0
    var maxInFlight = 0
    var dcSum = 0.0
    var sqSum = 0.0
    var rawFrames = 0L
    var lastCallbackMono = 0.0
    var maxCallbackGapMs = 0.0
    var interruptions = 0
    var restarts = 0
    var shortReads = 0
    var effects = ""
    var encoding = ""
    var lastPredMs = Double.NaN
  }

  private fun nowMono() = System.nanoTime() / 1e6

  fun isDebug(ctx: Context?) = ctx != null && (ctx.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

  // ---------- info / permission ----------

  private fun audioManager(ctx: Context) = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  fun unprocessedSupported(ctx: Context): Boolean =
    audioManager(ctx).getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) != null

  fun permission(ctx: Context): String =
    if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) "granted"
    else "undetermined"

  private fun routeOf(type: Int?): String = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_MIC -> "builtin"
    AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "bluetooth"
    AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
    null -> "builtin"
    else -> "other"
  }

  fun info(ctx: Context): Map<String, Any?> {
    val am = audioManager(ctx)
    val inputs = am.getDevices(AudioManager.GET_DEVICES_INPUTS)
    val sources = buildList {
      if (unprocessedSupported(ctx)) add("unprocessed")
      add("voice_recognition")
      add("mic")
    }
    val rates = inputs.flatMap { it.sampleRates.toList() }.distinct().sorted().map { it.toDouble() }
    return mapOf(
      "platform" to "android",
      "sources" to sources,
      "route" to routeOf(record?.routedDevice?.type),
      "routes" to inputs.map { routeOf(it.type) }.distinct(),
      "sampleRates" to if (rates.isEmpty()) listOf(48000.0, 44100.0) else rates,
      "permission" to permission(ctx),
    )
  }

  fun captureState(): Map<String, Any?> = synchronized(lock) {
    mapOf("running" to running, "mode" to if (running) "pcm" else null, "startedAtMs" to startedAtMs)
  }

  // ---------- start / stop ----------

  private fun pickSource(ctx: Context, wanted: String): Pair<Int, String> = when (wanted) {
    "unprocessed" -> {
      if (!unprocessedSupported(ctx)) throw MicException("source-unavailable", "UNPROCESSED is not supported on this device")
      AudioSourceId.UNPROCESSED to "unprocessed"
    }
    "voice_recognition" -> AudioSourceId.VOICE_RECOGNITION to "voice_recognition"
    "mic" -> AudioSourceId.MIC to "mic"
    "auto" -> if (unprocessedSupported(ctx)) AudioSourceId.UNPROCESSED to "unprocessed"
    else AudioSourceId.VOICE_RECOGNITION to "voice_recognition"
    else -> throw MicException("source-unavailable", "unknown source $wanted")
  }

  private fun build(source: Int, sampleRate: Int, encoding: Int, bytesPerFrame: Int): AudioRecord? {
    val min = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, encoding)
    if (min <= 0) return null
    val size = max(min * 4, sampleRate * bytesPerFrame / 2) // ≥ 0.5 s of slack inside AudioRecord
    return try {
      @Suppress("MissingPermission")
      val r = AudioRecord.Builder()
        .setAudioSource(source)
        .setAudioFormat(AudioFormat.Builder().setEncoding(encoding).setSampleRate(sampleRate).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build())
        .setBufferSizeInBytes(size)
        .build()
      if (r.state == AudioRecord.STATE_INITIALIZED) r else { r.release(); null }
    } catch (e: Exception) {
      null
    }
  }

  fun start(ctx: Context, o: Map<String, Any?>): Map<String, Any?> {
    if (running) stop(ctx)
    if (permission(ctx) != "granted") throw MicException("permission-denied", "RECORD_AUDIO not granted")
    appContext = ctx.applicationContext
    val wantRate = (o["sampleRate"] as? Number)?.toInt() ?: 48000
    val bufferMs = (o["bufferMs"] as? Number)?.toDouble() ?: 100.0
    val ringSeconds = (o["ringSeconds"] as? Number)?.toDouble() ?: 2.0
    background = o["background"] as? Boolean ?: false
    val (source, name) = pickSource(ctx, o["source"] as? String ?: "auto")

    // Microphone FGS first, while the app is visible (while-in-use rule, D16).
    if (background) {
      @Suppress("UNCHECKED_CAST")
      val n = o["notification"] as? Map<String, Any?>
      val i = Intent(ctx, MicCaptureService::class.java)
        .putExtra("title", n?.get("title") as? String ?: "Noise log")
        .putExtra("text", n?.get("text") as? String ?: "Measuring sound levels")
        .putExtra("stop", n?.get("stopLabel") as? String ?: "Stop")
      ContextCompat.startForegroundService(ctx, i)
    }

    var r: AudioRecord? = null
    var enc = ""
    var usedRate = wantRate
    loop@ for (fs in listOf(wantRate, 48000, 44100).distinct()) {
      r = build(source, fs, AudioFormat.ENCODING_PCM_FLOAT, 4)
      if (r != null) { enc = "float"; usedRate = fs; break@loop }
      r = build(source, fs, AudioFormat.ENCODING_PCM_16BIT, 2)
      if (r != null) { enc = "pcm16"; usedRate = fs; break@loop }
    }
    val rec = r ?: run {
      if (background) ctx.stopService(Intent(ctx, MicCaptureService::class.java))
      throw MicException("start-failed", "AudioRecord could not be initialised")
    }
    // built-in mic preferred (a headset mic must never feed a night log)
    if (o["preferBuiltIn"] as? Boolean != false) {
      audioManager(ctx).getDevices(AudioManager.GET_DEVICES_INPUTS)
        .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC }
        ?.let { rec.setPreferredDevice(it) }
    }
    val effects = disableEffects(rec.audioSessionId)
    synchronized(lock) {
      st = Stats()
      st.effects = effects
      st.encoding = enc
      rate = usedRate.toDouble()
      bufferFrames = (rate * bufferMs / 1000).toInt()
      ring = PcmRing((rate * maxOf(0.5, ringSeconds)).toInt())
      readCursor = ring.head
      pushCursor = ring.head
      inFlight = 0
      pendingDisc = true
      sourceName = name
      processed = name == "mic"
      silenced = false
      debugSilenced = false
      synthSpec?.let { synth = Synth.create(it, rate); synthStartMono = nowMono() }
      epochOffsetMs = System.currentTimeMillis() - nowMono()
      startedAtMs = System.currentTimeMillis().toDouble()
      record = rec
      running = true
    }
    try {
      rec.startRecording()
    } catch (e: Exception) {
      stop(ctx)
      throw MicException("mic-busy", "startRecording: ${e.message}")
    }
    if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
      stop(ctx)
      throw MicException("mic-busy", "the microphone is in use by another app")
    }
    registerCallbacks(ctx, rec)
    ensurePushThread()
    thread = Thread({ readLoop(rec, enc == "float") }, "mic-pcm-capture").also { it.start() }
    return mapOf(
      "sampleRate" to rate,
      "source" to name,
      "route" to routeOf(rec.routedDevice?.type),
      "framesPerBuffer" to bufferFrames,
      "processed" to processed,
    )
  }

  private fun disableEffects(session: Int): String {
    val found = mutableListOf<String>()
    try {
      if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(session)?.let { found += "agc:" + it.enabled; it.enabled = false }
      if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(session)?.let { found += "ns:" + it.enabled; it.enabled = false }
      if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(session)?.let { found += "aec:" + it.enabled; it.enabled = false }
    } catch (_: Exception) {
    }
    return found.joinToString(",")
  }

  fun stop(ctx: Context?) {
    val rec: AudioRecord?
    synchronized(lock) {
      running = false
      rec = record
      record = null
      startedAtMs = null
      ring.reset()
    }
    thread?.join(500)
    thread = null
    try { rec?.stop() } catch (_: Exception) {}
    rec?.release()
    unregisterCallbacks(ctx)
    if (background && ctx != null) ctx.stopService(Intent(ctx, MicCaptureService::class.java))
    background = false
  }

  // ---------- capture loop ----------

  private fun readLoop(rec: AudioRecord, float: Boolean) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
    val n = bufferFrames
    val f = FloatArray(n)
    val s = ShortArray(if (float) 0 else n)
    val ts = AudioTimestamp()
    var framesRead = 0L
    while (running) {
      val got = if (float) rec.read(f, 0, n, AudioRecord.READ_BLOCKING) else rec.read(s, 0, n, AudioRecord.READ_BLOCKING)
      if (got <= 0) {
        if (!running) break
        SystemClock.sleep(5)
        continue
      }
      if (!float) for (i in 0 until got) f[i] = s[i] / 32768f
      val first = framesRead
      framesRead += got
      // capture time of `first` on CLOCK_MONOTONIC (System.nanoTime), extrapolated on the sample clock
      var mono: Double
      val ok = rec.getTimestamp(ts, AudioTimestamp.TIMEBASE_MONOTONIC) == AudioRecord.SUCCESS
      synchronized(lock) {
        if (!running) return
        mono = if (ok) ts.nanoTime / 1e6 + (first - ts.framePosition) * 1000.0 / rate
        else nowMono() - got * 1000.0 / rate
        if (ok) st.tsOk++ else st.tsFallback++
        if (!st.lastPredMs.isNaN()) st.maxTsStepErrMs = maxOf(st.maxTsStepErrMs, abs(mono - st.lastPredMs))
        st.lastPredMs = mono + got * 1000.0 / rate
        if (got < n) st.shortReads++
        var dc = 0.0
        var sq = 0.0
        for (i in 0 until got) { val v = f[i].toDouble(); dc += v; sq += v * v }
        st.dcSum += dc
        st.sqSum += sq
        st.rawFrames += got
        if (debugSilenced) java.util.Arrays.fill(f, 0, got, 0f) // what Android delivers to a silenced client
        writeLocked(f, got, mono, pendingDisc)
      }
      pump()
    }
  }

  private var scratch = FloatArray(48000)

  private fun writeLocked(src: FloatArray, n: Int, mono: Double, disc: Boolean) {
    if (scratch.size < n) scratch = FloatArray(n)
    if (disc) synthIndex = Math.round((mono - synthStartMono) * rate / 1000)
    val replaced = synth != null || injectPos < inject.size
    val out = if (replaced) scratch else src
    val g = synth
    if (g != null) g.fill(out, n, synthIndex) else if (replaced) System.arraycopy(src, 0, out, 0, n)
    if (injectPos < inject.size) {
      val k = minOf(n, inject.size - injectPos)
      System.arraycopy(inject, injectPos, out, 0, k)
      injectPos += k
      if (injectPos >= inject.size) { inject = FloatArray(0); injectPos = 0 }
    }
    ring.write(out, n, mono, disc, rate)
    synthIndex += n
    pendingDisc = false
    st.callbacks++
    st.frames += n
    st.minFrames = minOf(st.minFrames, n)
    st.maxFrames = maxOf(st.maxFrames, n)
    val now = nowMono()
    if (st.lastCallbackMono > 0) st.maxCallbackGapMs = maxOf(st.maxCallbackGapMs, now - st.lastCallbackMono)
    st.lastCallbackMono = now
  }

  // ---------- delivery ----------

  /** Pull delivery: [frames, framePos, tMs, dropped, discontinuity 0/1, sampleRate]. */
  fun read(dest: FloatArray, maxFrames: Int, newest: Boolean): DoubleArray = synchronized(lock) {
    val (r, cur) = ring.read(readCursor, maxFrames, newest, dest)
    readCursor = cur
    doubleArrayOf(
      r.frames.toDouble(), r.framePos.toDouble(), if (r.frames > 0) r.monoMs + epochOffsetMs else nowMono() + epochOffsetMs,
      r.dropped.toDouble(), if (r.disc) 1.0 else 0.0, if (r.rate > 0) r.rate else rate,
    )
  }

  private fun ensurePushThread() {
    if (pushThread != null) return
    val t = HandlerThread("mic-pcm-push").also { it.start() }
    pushThread = t
    pushHandler = Handler(t.looper)
  }

  fun setPush(on: Boolean) {
    synchronized(lock) {
      pushEnabled = on
      pushCursor = maxOf(pushCursor, readCursor)
      inFlight = 0
    }
    ensurePushThread()
    if (on) pump()
  }

  fun ack() {
    synchronized(lock) { inFlight = maxOf(0, inFlight - 1) }
    pump()
  }

  /** Push delivery: ≤ 1 s per `buffer` event, at most MAX_IN_FLIGHT unacknowledged (see the Swift twin). */
  private fun pump() {
    pushHandler?.post {
      while (true) {
        val payload: Map<String, Any?>
        synchronized(lock) {
          if (!pushEnabled || !running || inFlight >= MAX_IN_FLIGHT) return@post
          val maxFrames = rate.toInt()
          if (pushScratch.size < maxFrames) pushScratch = FloatArray(maxFrames)
          val (r, cur) = ring.read(pushCursor, maxFrames, false, pushScratch)
          pushCursor = cur
          if (r.frames == 0 && r.dropped == 0L) return@post
          val bb = ByteBuffer.allocateDirect(maxOf(1, r.frames) * 4).order(ByteOrder.nativeOrder())
          bb.asFloatBuffer().put(pushScratch, 0, r.frames)
          inFlight++
          st.pushEvents++
          st.maxInFlight = maxOf(st.maxInFlight, inFlight)
          payload = mapOf(
            "data" to NativeArrayBuffer(bb),
            "frames" to r.frames,
            "framePos" to r.framePos.toDouble(),
            "tMs" to r.monoMs + epochOffsetMs,
            "dropped" to r.dropped.toDouble(),
            "discontinuity" to r.disc,
            "sampleRate" to r.rate,
          )
        }
        module?.emit("buffer", payload)
      }
    }
  }

  // ---------- silencing (another app or a call took the mic), routes ----------

  private fun reasonNow(): String {
    val ctx = appContext ?: return "unknown"
    return when (audioManager(ctx).mode) {
      AudioManager.MODE_IN_CALL, AudioManager.MODE_IN_COMMUNICATION, AudioManager.MODE_RINGTONE -> "call"
      else -> "other-app"
    }
  }

  private fun setSilenced(now: Boolean, reason: String) {
    val changed = synchronized(lock) {
      if (silenced == now) false else { silenced = now; if (now) st.interruptions++; true }
    }
    if (changed) module?.emit("interruption", mapOf("phase" to if (now) "began" else "ended", "reason" to reason))
  }

  private fun registerCallbacks(ctx: Context, rec: AudioRecord) {
    val am = audioManager(ctx)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val session = rec.audioSessionId
      val cb = object : AudioManager.AudioRecordingCallback() {
        override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
          val mine = configs.firstOrNull { it.clientAudioSessionId == session } ?: return
          setSilenced(mine.isClientSilenced, reasonNow())
        }
      }
      am.registerAudioRecordingCallback(cb, null)
      recordingCallback = cb
    }
    rec.addOnRoutingChangedListener({ r ->
      val type = r.routedDevice?.type
      module?.emit("route", mapOf("route" to routeOf(type), "builtin" to (type == null || type == AudioDeviceInfo.TYPE_BUILTIN_MIC)))
    }, null)
  }

  private fun unregisterCallbacks(ctx: Context?) {
    val cb = recordingCallback ?: return
    if (ctx != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) audioManager(ctx).unregisterAudioRecordingCallback(cb)
    recordingCallback = null
  }

  fun onStopRequested() {
    module?.emit("stopRequested", emptyMap())
  }

  // ---------- dev-only ----------

  fun setSynthetic(spec: Map<String, Any?>?) = synchronized(lock) {
    if (spec == null) { synth = null; synthSpec = null; return@synchronized }
    synth = Synth.create(spec, rate) ?: throw MicException("internal", "bad synthetic spec")
    synthSpec = spec
    synthStartMono = nowMono()
    synthIndex = 0
  }

  fun injectPcm(pcm: FloatArray): Double = synchronized(lock) {
    inject = pcm
    injectPos = 0
    if (running) ring.head.toDouble() else -1.0
  }

  /** What a silenced client sees: zeros plus the recording-callback transition (same handler as the real one). */
  fun debugInterruption(began: Boolean) {
    debugSilenced = began
    setSilenced(began, "unknown")
  }

  fun debugStats(): Map<String, Any?> = synchronized(lock) {
    val n = maxOf(1.0, st.rawFrames.toDouble())
    mapOf(
      "callbacks" to st.callbacks, "frames" to st.frames.toDouble(),
      "minFrames" to if (st.minFrames == Int.MAX_VALUE) 0 else st.minFrames, "maxFrames" to st.maxFrames,
      "tsOk" to st.tsOk, "tsFallback" to st.tsFallback, "maxTsStepErrMs" to st.maxTsStepErrMs,
      "restarts" to st.restarts, "interruptions" to st.interruptions, "pushEvents" to st.pushEvents,
      "maxInFlight" to st.maxInFlight, "inputDc" to st.dcSum / n, "inputRmsDbfs" to 10 * log10(maxOf(st.sqSum / n, 1e-20)),
      "maxCallbackGapMs" to st.maxCallbackGapMs, "shortReads" to st.shortReads, "effects" to st.effects,
      "encoding" to st.encoding, "source" to sourceName, "sampleRate" to rate, "ringFrames" to ring.capacity,
      "head" to ring.head.toDouble(), "silenced" to silenced, "foregroundService" to MicCaptureService.isRunning,
    )
  }
}
