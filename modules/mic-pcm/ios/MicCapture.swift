// iOS microphone capture for modules/mic-pcm (P3 spike, SPEC §5, D12, D15).
// AVAudioSession `.record` (meter) or `.playAndRecord` (tuner) in mode `.measurement` (no AGC / voice processing),
// built-in mic preferred, AVAudioEngine input tap at the HARDWARE rate (no resampling), first channel, Float32.
// Structure adapted from expo-audio's ios/AudioStream.swift (MIT, © 650 Industries / Expo); timing, ring buffer,
// interruption/route handling and the dev-only synthetic source are new.
// Timing contract (src/MicPcm.types.ts PcmChunk): the tap's `AVAudioTime.hostTime` (mach_absolute_time) is the capture
// time of the buffer's first frame; it is converted to epoch ms with ONE offset taken at start(). Every engine
// (re)start, interruption end, configuration change and hardware sample-time jump marks the next frame as a
// discontinuity. PCM stays in memory (ring buffer) and is never written anywhere (D13).
import AVFoundation
import ExpoModulesCore

final class MicCapture {
  static let shared = MicCapture()

  weak var module: MicPcmModule?

  private let lock = NSLock()
  private let pushQueue = DispatchQueue(label: "mic-pcm.push", qos: .userInitiated)
  private var engine: AVAudioEngine?
  private var ring = PcmRing(capacity: 48000 * 10)
  private var running = false
  private var startedAtMs: Double?
  private var epochOffsetMs = 0.0
  private var rate = 48000.0
  private var bufferMs = 100.0
  private var category = "record"
  private var preferBuiltIn = true
  private var pendingDisc = true
  private var interrupted = false
  private var observers: [NSObjectProtocol] = []

  // delivery
  private var readCursor: Int64 = 0
  private var pushCursor: Int64 = 0
  private var pushEnabled = false
  private var inFlight = 0
  private let maxInFlight = 4
  private var scratch = [Float](repeating: 0, count: 48000)
  private var pushScratch = [Float](repeating: 0, count: 48000)

  // dev-only sources
  private var synth: Synth?
  private var synthSpec: [String: Any]?
  private var synthIndex: Int64 = 0
  private var synthStartMono = 0.0
  private var inject: [Float] = []
  private var injectPos = 0
  private var clockTimer: DispatchSourceTimer?
  private var clockWritten: Int64 = 0
  private var clockStartMono = 0.0

  // hardware continuity + spike statistics
  private var lastSampleTime: Int64?
  private var lastFrames: Int64 = 0
  private var stats = Stats()

  struct Stats {
    var callbacks = 0
    var frames: Int64 = 0
    var minFrames = Int.max
    var maxFrames = 0
    var hwJumps = 0
    var invalidHostTime = 0
    var restarts = 0
    var interruptions = 0
    var pushEvents = 0
    var maxInFlight = 0
    var dcSum = 0.0
    var sqSum = 0.0
    var rawFrames: Int64 = 0
    var lastCallbackMono = 0.0
    var maxCallbackGapMs = 0.0
    var clockMode = false
  }

  // MARK: - time

  private static let timebase: Double = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return Double(info.numer) / Double(info.denom) / 1_000_000 // ms per host tick
  }()

  static func hostMs(_ host: UInt64) -> Double { Double(host) * timebase }
  static func nowMono() -> Double { hostMs(mach_absolute_time()) }

  // MARK: - info / permission

  static func routeName(_ port: AVAudioSession.Port?) -> String {
    switch port {
    case .builtInMic?: return "builtin"
    case .headsetMic?: return "wired"
    case .bluetoothHFP?: return "bluetooth"
    case .usbAudio?: return "usb"
    default: return "other"
    }
  }

  static func permission() -> String {
    if #available(iOS 17.0, *) {
      switch AVAudioApplication.shared.recordPermission {
      case .granted: return "granted"
      case .denied: return "denied"
      default: return "undetermined"
      }
    }
    switch AVAudioSession.sharedInstance().recordPermission {
    case .granted: return "granted"
    case .denied: return "denied"
    default: return "undetermined"
    }
  }

  static func requestPermission(_ done: @escaping (String) -> Void) {
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission { ok in done(ok ? "granted" : "denied") }
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission { ok in done(ok ? "granted" : "denied") }
    }
  }

  func info() -> [String: Any] {
    let s = AVAudioSession.sharedInstance()
    let input = s.currentRoute.inputs.first?.portType
    let routes = Array(Set((s.availableInputs ?? []).map { MicCapture.routeName($0.portType) }))
    return [
      "platform": "ios",
      "sources": ["ios_measurement"],
      "route": MicCapture.routeName(input),
      "routes": routes.isEmpty ? ["builtin"] : routes,
      "sampleRates": [s.sampleRate],
      "permission": MicCapture.permission(),
    ]
  }

  func captureState() -> [String: Any?] {
    lock.lock()
    defer { lock.unlock() }
    return ["running": running, "mode": running ? "pcm" : nil, "startedAtMs": startedAtMs]
  }

  // MARK: - start / stop

  func start(_ o: [String: Any]) throws -> [String: Any] {
    if running { stop() }
    let source = (o["source"] as? String) ?? "auto"
    if source != "auto" && source != "ios_measurement" {
      throw MicException("source-unavailable", "iOS offers only ios_measurement")
    }
    bufferMs = (o["bufferMs"] as? NSNumber)?.doubleValue ?? 100
    category = (o["category"] as? String) ?? "record"
    preferBuiltIn = (o["preferBuiltIn"] as? Bool) ?? true
    let wantRate = (o["sampleRate"] as? NSNumber)?.doubleValue ?? 48000
    let ringSeconds = (o["ringSeconds"] as? NSNumber)?.doubleValue ?? 2
    // dev diagnostics only: plain session mode, no preferred input (P3 attempt 3 on the simulator)
    let plainMode = (o["debugPlainMode"] as? Bool) ?? false

    // Simulator + dev synthetic source: never open the input (see the clock-mode note below).
    var useClock = false
    #if targetEnvironment(simulator)
    if synth != nil && !plainMode { useClock = true }
    #endif
    let session = AVAudioSession.sharedInstance()
    do {
      if useClock {
        try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
      } else if category == "playAndRecord" {
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetoothA2DP])
      } else {
        try session.setCategory(.record, mode: plainMode ? .default : .measurement, options: [])
      }
      try? session.setPreferredSampleRate(wantRate)
      try session.setActive(true)
    } catch {
      throw MicException("mic-busy", "audio session: \(error.localizedDescription)")
    }
    if !plainMode && !useClock { applyPreferredInput() }
    epochOffsetMs = Date().timeIntervalSince1970 * 1000 - MicCapture.nowMono()

    lock.lock()
    stats = Stats()
    lastSampleTime = nil
    pendingDisc = true
    lock.unlock()

    #if targetEnvironment(simulator)
    // P3 finding: on this Mac the simulator's audio server deadlocks in AudioUnit Initialize as soon as the input node
    // is touched ("RPC timeout. Apparently deadlocked. Aborting now." — the app is killed). With the dev synthetic
    // source the simulator therefore never opens the input: frames come from the host clock, and a silent output
    // engine (category .playback, so no input either) keeps the audio session — and the background-audio process —
    // alive. Real-input capture = device only.
    #endif
    if !useClock {
      do {
        try startEngine()
      } catch {
        if synth == nil { throw error }
        useClock = true
      }
    }
    if useClock && !plainMode { startKeepAlive() }
    lock.lock()
    if useClock { rate = wantRate }
    ring = PcmRing(capacity: Int(rate * max(0.5, ringSeconds)))
    readCursor = ring.head
    pushCursor = ring.head
    inFlight = 0
    running = true
    interrupted = false
    startedAtMs = Date().timeIntervalSince1970 * 1000
    if synth != nil, let spec = synthSpec { synth = Synth(spec: spec, rate: rate); synthStartMono = MicCapture.nowMono() }
    stats.clockMode = useClock
    lock.unlock()
    if useClock { startClock() }
    observe()
    let route = MicCapture.routeName(session.currentRoute.inputs.first?.portType)
    return [
      "sampleRate": rate,
      "source": "ios_measurement",
      "route": route,
      "framesPerBuffer": Int(rate * bufferMs / 1000),
      "processed": false,
    ]
  }

  private func applyPreferredInput() {
    guard preferBuiltIn else { return }
    let s = AVAudioSession.sharedInstance()
    if let builtin = s.availableInputs?.first(where: { $0.portType == .builtInMic }) {
      try? s.setPreferredInput(builtin)
    }
  }

  private func startEngine() throws {
    let e = AVAudioEngine()
    let input = e.inputNode
    let fmt = input.outputFormat(forBus: 0)
    guard fmt.sampleRate > 0, fmt.channelCount > 0 else {
      throw MicException("source-unavailable", "no input device (rate \(fmt.sampleRate), \(fmt.channelCount) ch)")
    }
    lock.lock()
    rate = fmt.sampleRate
    if scratch.count < Int(rate * 2) { scratch = [Float](repeating: 0, count: Int(rate * 2)) }
    lock.unlock()
    let size = AVAudioFrameCount(fmt.sampleRate * bufferMs / 1000)
    input.installTap(onBus: 0, bufferSize: size, format: fmt) { [weak self] buffer, when in
      self?.onTap(buffer, when)
    }
    e.prepare()
    do {
      try e.start()
    } catch {
      input.removeTap(onBus: 0)
      throw MicException("start-failed", "engine: \(error.localizedDescription)")
    }
    engine = e
  }

  private func stopEngine() {
    engine?.inputNode.removeTap(onBus: 0)
    engine?.stop()
    engine = nil
  }

  func stop() {
    stopClock()
    stopEngine()
    unobserve()
    lock.lock()
    running = false
    startedAtMs = nil
    interrupted = false
    ring.reset()
    lock.unlock()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  // MARK: - capture callback

  private func onTap(_ buffer: AVAudioPCMBuffer, _ when: AVAudioTime) {
    let n = Int(buffer.frameLength)
    guard n > 0, let ch = buffer.floatChannelData else { return }
    let mono: Double
    lock.lock()
    if when.isHostTimeValid {
      mono = MicCapture.hostMs(when.hostTime)
    } else {
      mono = MicCapture.nowMono() - Double(n) * 1000 / rate
      stats.invalidHostTime += 1
    }
    var disc = pendingDisc
    if when.isSampleTimeValid {
      if let last = lastSampleTime, when.sampleTime != last + lastFrames {
        disc = true
        stats.hwJumps += 1
      }
      lastSampleTime = when.sampleTime
      lastFrames = Int64(n)
    }
    let src = ch[0]
    var dc = 0.0
    var sq = 0.0
    for i in 0..<n {
      let v = Double(src[i])
      dc += v
      sq += v * v
    }
    stats.dcSum += dc
    stats.sqSum += sq
    stats.rawFrames += Int64(n)
    writeLocked(src, count: n, mono: mono, disc: disc)
    lock.unlock()
    pump()
  }

  /// Writes one buffer (mic, or replaced by the dev source) into the ring. Caller holds the lock.
  private func writeLocked(_ src: UnsafePointer<Float>, count n: Int, mono: Double, disc: Bool) {
    if scratch.count < n { scratch = [Float](repeating: 0, count: n) }
    if disc { synthIndex = Int64(((mono - synthStartMono) * rate / 1000).rounded()) }
    let replaced = synth != nil || injectPos < inject.count
    scratch.withUnsafeMutableBufferPointer { s in
      let p = s.baseAddress!
      if let g = synth { g.fill(p, count: n, index: synthIndex) } else { p.update(from: src, count: n) }
      if injectPos < inject.count {
        let k = min(n, inject.count - injectPos)
        inject.withUnsafeBufferPointer { inj in (p).update(from: inj.baseAddress! + injectPos, count: k) }
        injectPos += k
        if injectPos >= inject.count { inject = []; injectPos = 0 }
      }
      ring.write(replaced ? UnsafePointer(p) : src, count: n, monoMs: mono, disc: disc, rate: rate)
    }
    synthIndex += Int64(n)
    pendingDisc = false
    stats.callbacks += 1
    stats.frames += Int64(n)
    stats.minFrames = min(stats.minFrames, n)
    stats.maxFrames = max(stats.maxFrames, n)
    let now = MicCapture.nowMono()
    if stats.lastCallbackMono > 0 { stats.maxCallbackGapMs = max(stats.maxCallbackGapMs, now - stats.lastCallbackMono) }
    stats.lastCallbackMono = now
  }

  // MARK: - host clock (dev synthetic source without an input device)

  private func startClock() {
    clockStartMono = MicCapture.nowMono()
    clockWritten = 0
    let t = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .userInitiated))
    t.schedule(deadline: .now() + .milliseconds(Int(bufferMs)), repeating: .milliseconds(Int(bufferMs)))
    t.setEventHandler { [weak self] in self?.clockTick() }
    clockTimer = t
    t.resume()
  }

  private func stopClock() {
    stopClockTimer()
    keepAlive?.stop()
    keepAlive = nil
  }

  private func stopClockTimer() {
    clockTimer?.cancel()
    clockTimer = nil
  }

  private var keepAlive: AVAudioEngine?

  /// Simulator clock mode only: a silent output so the audio session is really running (background audio mode).
  private func startKeepAlive() {
    let e = AVAudioEngine()
    let fmt = e.outputNode.inputFormat(forBus: 0)
    guard fmt.sampleRate > 0 else { return }
    let src = AVAudioSourceNode { _, _, frameCount, abl -> OSStatus in
      for b in UnsafeMutableAudioBufferListPointer(abl) { memset(b.mData, 0, Int(b.mDataByteSize)) }
      _ = frameCount
      return noErr
    }
    e.attach(src)
    e.connect(src, to: e.mainMixerNode, format: AVAudioFormat(standardFormatWithSampleRate: fmt.sampleRate, channels: 1))
    do {
      try e.start()
      keepAlive = e
    } catch {
      module?.sendEvent("error", ["code": "internal", "message": "keep-alive output: \(error.localizedDescription)"])
    }
  }

  private func clockTick() {
    lock.lock()
    let due = Int64(((MicCapture.nowMono() - clockStartMono) * rate / 1000).rounded(.down))
    let n = Int(min(due - clockWritten, Int64(rate)))
    if n > 0 {
      let mono = clockStartMono + Double(clockWritten) * 1000 / rate
      var zeros = [Float](repeating: 0, count: n)
      zeros.withUnsafeMutableBufferPointer { z in writeLocked(z.baseAddress!, count: n, mono: mono, disc: pendingDisc) }
      clockWritten += Int64(n)
    }
    lock.unlock()
    if n > 0 { pump() }
  }

  // MARK: - delivery

  /// Pull delivery: [frames, framePos, tMs, dropped, discontinuity 0/1, sampleRate].
  func read(into dest: UnsafeMutablePointer<Float>, maxFrames: Int, newest: Bool) -> [Double] {
    lock.lock()
    defer { lock.unlock() }
    let r = ring.read(cursor: &readCursor, maxFrames: maxFrames, newest: newest, into: dest)
    return [Double(r.frames), Double(r.framePos), r.frames > 0 ? r.monoMs + epochOffsetMs : MicCapture.nowMono() + epochOffsetMs,
            Double(r.dropped), r.disc ? 1 : 0, r.rate > 0 ? r.rate : rate]
  }

  func setPush(_ on: Bool) {
    lock.lock()
    pushEnabled = on
    pushCursor = max(pushCursor, readCursor)
    inFlight = 0
    lock.unlock()
    if on { pump() }
  }

  func ack() {
    lock.lock()
    inFlight = max(0, inFlight - 1)
    lock.unlock()
    pump()
  }

  /// Push delivery: one `buffer` event per available piece (≤ 1 s), at most `maxInFlight` unacknowledged events. When
  /// JS stalls, events stop, the ring keeps filling and finally overwrites: the next event reports the loss as dropped.
  private func pump() {
    pushQueue.async { [weak self] in
      guard let self else { return }
      while true {
        self.lock.lock()
        guard self.pushEnabled, self.running, self.inFlight < self.maxInFlight else { self.lock.unlock(); return }
        let maxFrames = Int(self.rate)
        if self.pushScratch.count < maxFrames { self.pushScratch = [Float](repeating: 0, count: maxFrames) }
        let r = self.pushScratch.withUnsafeMutableBufferPointer { p in
          self.ring.read(cursor: &self.pushCursor, maxFrames: maxFrames, newest: false, into: p.baseAddress!)
        }
        if r.frames == 0 && r.dropped == 0 { self.lock.unlock(); return }
        // Data becomes a Uint8Array over a fresh ArrayBuffer in JS (one copy); a NativeArrayBuffer inside a
        // sendEvent dictionary arrived empty on SDK 57 (P3 finding).
        let data = self.pushScratch.withUnsafeBytes { raw in Data(bytes: raw.baseAddress!, count: r.frames * 4) }
        self.inFlight += 1
        self.stats.pushEvents += 1
        self.stats.maxInFlight = max(self.stats.maxInFlight, self.inFlight)
        let payload: [String: Any] = [
          "data": data,
          "frames": r.frames,
          "framePos": Double(r.framePos),
          "tMs": r.monoMs + self.epochOffsetMs,
          "dropped": Double(r.dropped),
          "discontinuity": r.disc,
          "sampleRate": r.rate,
        ]
        self.lock.unlock()
        self.module?.sendEvent("buffer", payload)
      }
    }
  }

  // MARK: - dev-only sources

  func setSynthetic(_ spec: [String: Any]?) throws {
    lock.lock()
    defer { lock.unlock() }
    guard let spec else { synth = nil; synthSpec = nil; return }
    guard let g = Synth(spec: spec, rate: rate) else { throw MicException("internal", "bad synthetic spec") }
    synth = g
    synthSpec = spec
    synthStartMono = MicCapture.nowMono()
    synthIndex = 0
  }

  /// Replaces the next frames by `pcm` (at the current hardware rate). Returns the framePos of its first frame.
  func injectPcm(_ pcm: UnsafeBufferPointer<Float>) -> Double {
    lock.lock()
    defer { lock.unlock() }
    inject = Array(pcm)
    injectPos = 0
    return running ? Double(ring.head) : -1
  }

  /// What a real interruption does: the system stops the engine, later the app resumes it. `began` stops the engine and
  /// posts the system notification; `ended` posts the end notification (our handler restarts).
  func debugInterruption(_ began: Bool) {
    if began {
      stopEngine()
      stopClockTimer()
    }
    let type: AVAudioSession.InterruptionType = began ? .began : .ended
    var info: [AnyHashable: Any] = [AVAudioSessionInterruptionTypeKey: type.rawValue]
    if !began { info[AVAudioSessionInterruptionOptionKey] = AVAudioSession.InterruptionOptions.shouldResume.rawValue }
    NotificationCenter.default.post(name: AVAudioSession.interruptionNotification, object: AVAudioSession.sharedInstance(), userInfo: info)
  }

  func debugStats() -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    let n = max(1, Double(stats.rawFrames))
    return [
      "callbacks": stats.callbacks, "frames": Double(stats.frames),
      "minFrames": stats.minFrames == Int.max ? 0 : stats.minFrames, "maxFrames": stats.maxFrames,
      "hwJumps": stats.hwJumps, "invalidHostTime": stats.invalidHostTime, "restarts": stats.restarts,
      "interruptions": stats.interruptions, "pushEvents": stats.pushEvents, "maxInFlight": stats.maxInFlight,
      "inputDc": stats.dcSum / n, "inputRmsDbfs": 10 * log10(max(stats.sqSum / n, 1e-20)),
      "maxCallbackGapMs": stats.maxCallbackGapMs, "clockMode": stats.clockMode, "sampleRate": rate,
      "ringFrames": ring.capacity, "head": Double(ring.head),
    ]
  }

  // MARK: - interruptions, routes, configuration changes

  private func observe() {
    guard observers.isEmpty else { return }
    let nc = NotificationCenter.default
    let s = AVAudioSession.sharedInstance()
    observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: s, queue: .main) { [weak self] n in
      self?.onInterruption(n)
    })
    observers.append(nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: s, queue: .main) { [weak self] n in
      self?.onRouteChange(n)
    })
    observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: s, queue: .main) { [weak self] _ in
      self?.restart(reason: "media services reset")
    })
    observers.append(nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] n in
      guard let self, let e = n.object as? AVAudioEngine, e === self.engine else { return }
      self.restart(reason: "configuration change")
    })
  }

  private func unobserve() {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers = []
  }

  private func onInterruption(_ n: Notification) {
    guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
    var reason = "unknown"
    if #available(iOS 14.5, *), let r = n.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt,
       let why = AVAudioSession.InterruptionReason(rawValue: r) {
      switch why {
      case .builtInMicMuted: reason = "system"
      case .default: reason = "unknown"
      default: reason = "system"
      }
    }
    if type == .began {
      lock.lock()
      interrupted = true
      stats.interruptions += 1
      lock.unlock()
      stopEngine()
      stopClockTimer()
      module?.sendEvent("interruption", ["phase": "began", "reason": reason])
    } else {
      module?.sendEvent("interruption", ["phase": "ended", "reason": reason])
      lock.lock()
      interrupted = false
      lock.unlock()
      restart(reason: "interruption ended")
    }
  }

  private func onRouteChange(_ n: Notification) {
    let s = AVAudioSession.sharedInstance()
    let port = s.currentRoute.inputs.first?.portType
    module?.sendEvent("route", ["route": MicCapture.routeName(port), "builtin": port == .builtInMic])
    if port != .builtInMic { applyPreferredInput() }
  }

  /// Restarts the engine after an interruption or a configuration change; the first new frame is a discontinuity.
  private func restart(reason: String) {
    lock.lock()
    let shouldRun = running && !interrupted
    let clock = stats.clockMode
    let oldRate = rate
    if shouldRun && clock {
      pendingDisc = true
      stats.restarts += 1
    }
    lock.unlock()
    guard shouldRun else { return }
    if clock {
      if clockTimer == nil { startClock() }
      return
    }
    stopEngine()
    do {
      try AVAudioSession.sharedInstance().setActive(true)
      try startEngine()
      lock.lock()
      pendingDisc = true
      lastSampleTime = nil
      stats.restarts += 1
      let newRate = rate
      if newRate != oldRate, let spec = synthSpec { synth = Synth(spec: spec, rate: newRate) }
      lock.unlock()
      if newRate != oldRate { module?.sendEvent("format", ["sampleRate": newRate]) }
    } catch {
      module?.sendEvent("error", ["code": "mic-busy", "message": "restart after \(reason) failed: \(error.localizedDescription)"])
    }
  }
}

final class MicException: Exception, @unchecked Sendable {
  init(_ code: String, _ reason: String) {
    super.init(name: "MicPcmException", description: reason, code: code)
  }
}
