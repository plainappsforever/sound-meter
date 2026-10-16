// Expo module surface of modules/mic-pcm on Android. Typed API + timing contract: src/MicPcm.types.ts; JS wrapper:
// src/MicPcmModule.ts. No function here writes audio anywhere (D13, A12 scan in src/no-audio.test.ts).
package expo.modules.micpcm

import android.Manifest
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.Float32Array
import java.nio.ByteOrder

class MicPcmModule : Module() {
  private val ctx get() = appContext.reactContext ?: throw MicException("internal", "no React context")

  fun emit(name: String, body: Map<String, Any?>) = sendEvent(name, body)

  private fun debugOnly() {
    if (!MicCore.isDebug(appContext.reactContext)) throw MicException("internal", "dev builds only")
  }

  override fun definition() = ModuleDefinition {
    Name("MicPcm")

    Events("buffer", "interruption", "route", "stopRequested", "error", "levels", "format")

    OnCreate { MicCore.module = this@MicPcmModule }

    OnDestroy {
      if (MicCore.module === this@MicPcmModule) MicCore.module = null
    }

    AsyncFunction("getInfo") { MicCore.info(ctx) }

    AsyncFunction("requestPermission") { promise: Promise ->
      val pm = appContext.permissions ?: throw MicException("internal", "permissions module missing")
      pm.askForPermissions({ _ ->
        promise.resolve(if (MicCore.permission(ctx) == "granted") "granted" else "denied")
      }, Manifest.permission.RECORD_AUDIO)
    }

    AsyncFunction("start") { options: Map<String, Any?> -> MicCore.start(ctx, options) }

    AsyncFunction("stop") { MicCore.stop(ctx) }

    /** Pull delivery into a caller-owned Float32Array: [frames, framePos, tMs, dropped, discontinuity, sampleRate]. */
    Function("readInto") { dest: Float32Array, maxFrames: Int, newest: Boolean ->
      val n = minOf(maxFrames, dest.length)
      val tmp = FloatArray(maxOf(1, n))
      val r = MicCore.read(tmp, n, newest)
      val frames = r[0].toInt()
      if (frames > 0) dest.toDirectBuffer().order(ByteOrder.nativeOrder()).asFloatBuffer().put(tmp, 0, frames)
      r
    }

    Function("setPush") { on: Boolean -> MicCore.setPush(on) }

    Function("ack") { MicCore.ack() }

    Function("updateNotification") { text: String -> MicCaptureService.update(ctx, text) }

    Function("getCaptureState") { MicCore.captureState() }

    Function("isDebug") { MicCore.isDebug(appContext.reactContext) }

    // Dev builds only (D24): refused unless the app is debuggable; the JS wrapper leaves them undefined otherwise.
    AsyncFunction("setSyntheticSource") { spec: Map<String, Any?>? ->
      debugOnly()
      MicCore.setSynthetic(spec)
    }

    Function("injectPcm") { pcm: Float32Array ->
      debugOnly()
      val a = FloatArray(pcm.length)
      pcm.toDirectBuffer().order(ByteOrder.nativeOrder()).asFloatBuffer().get(a)
      MicCore.injectPcm(a)
    }

    Function("debugInterruption") { began: Boolean ->
      debugOnly()
      MicCore.debugInterruption(began)
    }

    Function("debugStats") {
      debugOnly()
      MicCore.debugStats()
    }
  }
}
