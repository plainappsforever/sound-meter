// Ring buffer of mono Float32 frames with the PcmChunk TIMING CONTRACT (src/MicPcm.types.ts).
// Each write records an anchor (framePos, monotonic capture ms of its first frame, discontinuity, sample rate). A read
// returns contiguous frames from one burst only: it never crosses an anchor that starts a new burst (discontinuity or
// rate change), so the consumer can anchor time once per burst. Audio lives here in memory only and is overwritten
// after `capacity` frames; nothing in this module writes it anywhere (SPEC §3.5, D13).
// Not thread-safe by itself: MicCapture serialises every call under one lock.
import Foundation

final class PcmRing {
  struct Anchor {
    var framePos: Int64
    var monoMs: Double
    var disc: Bool
    var rate: Double
  }

  struct ReadResult {
    var frames: Int
    var framePos: Int64
    var monoMs: Double
    var dropped: Int64
    var disc: Bool
    var rate: Double
  }

  let capacity: Int
  private var buf: [Float]
  /// framePos of the next frame to be written (= frames written since the ring was created).
  private(set) var head: Int64 = 0
  private var anchors: [Anchor] = []

  init(capacity: Int) {
    self.capacity = max(1, capacity)
    buf = [Float](repeating: 0, count: self.capacity)
  }

  /// Oldest frame still held.
  var tail: Int64 {
    let byCapacity = head - Int64(capacity)
    return max(byCapacity, anchors.first?.framePos ?? head)
  }

  func write(_ src: UnsafePointer<Float>, count: Int, monoMs: Double, disc: Bool, rate: Double) {
    guard count > 0 else { return }
    anchors.append(Anchor(framePos: head, monoMs: monoMs, disc: disc, rate: rate))
    var done = 0
    buf.withUnsafeMutableBufferPointer { dst in
      while done < count {
        let idx = Int((head + Int64(done)) % Int64(capacity))
        let n = min(count - done, capacity - idx)
        (dst.baseAddress! + idx).update(from: src + done, count: n)
        done += n
      }
    }
    head += Int64(count)
    let oldest = head - Int64(capacity)
    // keep the anchor that contains `oldest`
    var drop = 0
    while drop + 1 < anchors.count && anchors[drop + 1].framePos <= oldest { drop += 1 }
    if drop > 0 { anchors.removeFirst(drop) }
  }

  /// Index of the last anchor with framePos <= pos.
  private func anchorIndex(_ pos: Int64) -> Int {
    var lo = 0
    var hi = anchors.count - 1
    while lo < hi {
      let mid = (lo + hi + 1) / 2
      if anchors[mid].framePos <= pos { lo = mid } else { hi = mid - 1 }
    }
    return lo
  }

  /// 'oldest': the next frames after `cursor` (lost ones reported as dropped). 'newest': the latest `maxFrames` frames
  /// after `cursor`, skipping older ones (also reported as dropped). Moves `cursor` past the returned frames.
  func read(cursor: inout Int64, maxFrames: Int, newest: Bool, into dest: UnsafeMutablePointer<Float>) -> ReadResult {
    guard !anchors.isEmpty, maxFrames > 0 else {
      return ReadResult(frames: 0, framePos: cursor, monoMs: 0, dropped: 0, disc: false, rate: anchors.last?.rate ?? 0)
    }
    var start = max(cursor, tail)
    if newest {
      start = max(start, head - Int64(maxFrames))
      // only frames after the latest break
      if let lastBreak = anchors.lastIndex(where: { $0.framePos > start && $0.framePos < head && ($0.disc) }) {
        start = anchors[lastBreak].framePos
      }
    }
    let dropped = start - cursor
    if start >= head {
      cursor = head
      let a = anchors[anchors.count - 1]
      return ReadResult(frames: 0, framePos: head, monoMs: a.monoMs + Double(head - a.framePos) * 1000 / a.rate,
                        dropped: max(0, dropped), disc: false, rate: a.rate)
    }
    let ai = anchorIndex(start)
    let a = anchors[ai]
    var end = min(head, start + Int64(maxFrames))
    var j = ai + 1
    while j < anchors.count && anchors[j].framePos < end {
      if anchors[j].disc || anchors[j].rate != a.rate {
        end = anchors[j].framePos
        break
      }
      j += 1
    }
    let n = Int(end - start)
    var done = 0
    buf.withUnsafeBufferPointer { src in
      while done < n {
        let idx = Int((start + Int64(done)) % Int64(capacity))
        let k = min(n - done, capacity - idx)
        (dest + done).update(from: src.baseAddress! + idx, count: k)
        done += k
      }
    }
    cursor = end
    return ReadResult(frames: n, framePos: start, monoMs: a.monoMs + Double(start - a.framePos) * 1000 / a.rate,
                      dropped: max(0, dropped), disc: a.disc && start == a.framePos, rate: a.rate)
  }

  /// Forgets the time anchors (stop): the next write starts a new burst.
  func reset() {
    anchors.removeAll()
  }
}
