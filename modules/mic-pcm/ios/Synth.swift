// Dev-only deterministic signals (D24, SyntheticSpec in src/MicPcm.types.ts). They REPLACE the microphone samples at
// the capture callback, so timing, ring buffer and delivery stay the real ones. Levels are RMS dBFS re full scale 1.0
// (a sine of RMS r dBFS has amplitude √2·10^(r/20)). Same formulas as the Kotlin twin (Synth.kt).
import Foundation

final class Synth {
  private enum Kind {
    case sine(hz: Double, amp: Double)
    case multitone([(hz: Double, amp: Double)])
    case burst(hz: Double, amp: Double, burst: Int, every: Int)
    case noise(amp: Double) // uniform white noise; RMS = amp/√3
    case zeros
    case script(steps: [(frames: Int, amp: Double, hz: Double)], loop: Bool)
  }

  private let kind: Kind
  private let rate: Double
  private var seed: UInt32 = 0x1234_5678

  private static func sineAmp(_ rmsDbfs: Double) -> Double { sqrt(2.0) * pow(10.0, rmsDbfs / 20.0) }

  init?(spec: [String: Any], rate: Double) {
    self.rate = rate
    let num = { (k: String) -> Double? in (spec[k] as? NSNumber)?.doubleValue }
    switch spec["kind"] as? String {
    case "sine":
      guard let hz = num("hz"), let r = num("rmsDbfs") else { return nil }
      kind = .sine(hz: hz, amp: Synth.sineAmp(r))
    case "multitone":
      guard let tones = spec["tones"] as? [[String: Any]] else { return nil }
      kind = .multitone(tones.compactMap { t in
        guard let hz = (t["hz"] as? NSNumber)?.doubleValue, let r = (t["rmsDbfs"] as? NSNumber)?.doubleValue else { return nil }
        return (hz, Synth.sineAmp(r))
      })
    case "burst":
      guard let hz = num("hz"), let r = num("rmsDbfs"), let b = num("burstMs"), let e = num("everyMs") else { return nil }
      kind = .burst(hz: hz, amp: Synth.sineAmp(r), burst: Int(b * rate / 1000), every: max(1, Int(e * rate / 1000)))
    case "silence":
      guard let r = num("rmsDbfs") else { return nil }
      kind = .noise(amp: sqrt(3.0) * pow(10.0, r / 20.0))
    case "zeros":
      kind = .zeros
    case "script":
      guard let steps = spec["steps"] as? [[String: Any]] else { return nil }
      kind = .script(steps: steps.compactMap { s in
        guard let sec = (s["seconds"] as? NSNumber)?.doubleValue, let r = (s["rmsDbfs"] as? NSNumber)?.doubleValue else { return nil }
        return (Int(sec * rate), Synth.sineAmp(r), (s["hz"] as? NSNumber)?.doubleValue ?? 1000)
      }, loop: (spec["loop"] as? Bool) ?? false)
    default:
      return nil
    }
  }

  private func uniform() -> Double {
    seed = seed &* 1_664_525 &+ 1_013_904_223
    return Double(seed) / Double(UInt32.max) * 2 - 1
  }

  /// Fills `n` samples for synthesis sample indices index ..< index+n.
  func fill(_ out: UnsafeMutablePointer<Float>, count n: Int, index: Int64) {
    let w = 2 * Double.pi / rate
    switch kind {
    case let .sine(hz, amp):
      for i in 0..<n { out[i] = Float(amp * sin(w * hz * Double(index + Int64(i)))) }
    case let .multitone(tones):
      for i in 0..<n {
        let k = Double(index + Int64(i))
        var x = 0.0
        for t in tones { x += t.amp * sin(w * t.hz * k) }
        out[i] = Float(x)
      }
    case let .burst(hz, amp, burst, every):
      for i in 0..<n {
        let k = index + Int64(i)
        out[i] = Int(k % Int64(every)) < burst ? Float(amp * sin(w * hz * Double(k))) : 0
      }
    case let .noise(amp):
      for i in 0..<n { out[i] = Float(amp * uniform()) }
    case .zeros:
      for i in 0..<n { out[i] = 0 }
    case let .script(steps, loop):
      let total = Int64(steps.reduce(0) { $0 + $1.frames })
      for i in 0..<n {
        var k = index + Int64(i)
        if loop && total > 0 { k %= total }
        var amp = 0.0
        var hz = 1000.0
        var acc: Int64 = 0
        for s in steps {
          if k < acc + Int64(s.frames) {
            amp = s.amp
            hz = s.hz
            break
          }
          acc += Int64(s.frames)
        }
        out[i] = Float(amp * sin(w * hz * Double(index + Int64(i))))
      }
    }
  }
}
