// Expo module surface of modules/mic-pcm on iOS. The typed API (and its timing contract) is src/MicPcm.types.ts;
// the JS wrapper is src/MicPcmModule.ts. No function here writes audio anywhere (D13, A12 scan in src/no-audio.test.ts).
import ExpoModulesCore

public class MicPcmModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MicPcm")

    Events("buffer", "interruption", "route", "stopRequested", "error", "levels", "format")

    OnCreate {
      MicCapture.shared.module = self
    }

    AsyncFunction("getInfo") { () -> [String: Any] in
      MicCapture.shared.info()
    }

    AsyncFunction("requestPermission") { (promise: Promise) in
      MicCapture.requestPermission { promise.resolve($0) }
    }

    // Session + engine setup on the main queue (AVAudioSession/AVAudioEngine state changes, notifications on .main).
    AsyncFunction("start") { (options: [String: Any]) -> [String: Any] in
      try MicCapture.shared.start(options)
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      MicCapture.shared.stop()
    }.runOnQueue(.main)

    /// Pull delivery into a caller-owned Float32Array: [frames, framePos, tMs, dropped, discontinuity, sampleRate].
    Function("readInto") { (dest: Float32Array, maxFrames: Int, newest: Bool) -> [Double] in
      let n = min(maxFrames, dest.length)
      let p = dest.rawPointer.bindMemory(to: Float.self, capacity: max(1, n))
      return MicCapture.shared.read(into: p, maxFrames: n, newest: newest)
    }

    Function("setPush") { (on: Bool) in
      MicCapture.shared.setPush(on)
    }

    Function("ack") {
      MicCapture.shared.ack()
    }

    Function("updateNotification") { (_: String) in
      // iOS shows its own microphone indicator; there is no notification to update.
    }

    Function("getCaptureState") { () -> [String: Any?] in
      MicCapture.shared.captureState()
    }

    Function("isDebug") { () -> Bool in
      #if DEBUG
      return true
      #else
      return false
      #endif
    }

    // Dev builds only (D24): the bodies are compiled out of Release builds (they throw there), and the JS wrapper
    // leaves these members undefined unless isDebug() is true.
    AsyncFunction("setSyntheticSource") { (spec: [String: Any]?) in
      #if DEBUG
      try MicCapture.shared.setSynthetic(spec)
      #else
      throw MicException("internal", "dev builds only")
      #endif
    }

    Function("injectPcm") { (pcm: Float32Array) throws -> Double in
      #if DEBUG
      let p = pcm.rawPointer.bindMemory(to: Float.self, capacity: max(1, pcm.length))
      return MicCapture.shared.injectPcm(UnsafeBufferPointer(start: p, count: pcm.length))
      #else
      throw MicException("internal", "dev builds only")
      #endif
    }

    Function("debugInterruption") { (began: Bool) throws in
      #if DEBUG
      MicCapture.shared.debugInterruption(began)
      #else
      throw MicException("internal", "dev builds only")
      #endif
    }

    Function("debugStats") { () -> [String: Any] in
      #if DEBUG
      return MicCapture.shared.debugStats()
      #else
      return [:]
      #endif
    }
  }
}
