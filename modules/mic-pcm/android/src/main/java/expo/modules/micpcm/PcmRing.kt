// Ring buffer of mono float frames with the PcmChunk TIMING CONTRACT (src/MicPcm.types.ts); twin of ios/PcmRing.swift.
// Each write records an anchor (framePos, monotonic capture ms of its first frame, discontinuity, rate). A read returns
// frames of one burst only (never across an anchor with a discontinuity or another rate). Audio stays in memory and
// is overwritten after `capacity` frames; nothing in this module writes it anywhere (SPEC §3.5, D13).
// Not thread-safe by itself: MicCore serialises every call under one lock.
package expo.modules.micpcm

class PcmRing(capacity: Int) {
  data class Anchor(val framePos: Long, val monoMs: Double, val disc: Boolean, val rate: Double)
  data class ReadResult(val frames: Int, val framePos: Long, val monoMs: Double, val dropped: Long, val disc: Boolean, val rate: Double)

  val capacity = maxOf(1, capacity)
  private val buf = FloatArray(this.capacity)
  var head = 0L
    private set
  private val anchors = ArrayList<Anchor>()

  val tail: Long
    get() = maxOf(head - capacity, anchors.firstOrNull()?.framePos ?: head)

  fun write(src: FloatArray, count: Int, monoMs: Double, disc: Boolean, rate: Double) {
    if (count <= 0) return
    anchors.add(Anchor(head, monoMs, disc, rate))
    var done = 0
    while (done < count) {
      val idx = ((head + done) % capacity).toInt()
      val n = minOf(count - done, capacity - idx)
      System.arraycopy(src, done, buf, idx, n)
      done += n
    }
    head += count
    val oldest = head - capacity
    var drop = 0
    while (drop + 1 < anchors.size && anchors[drop + 1].framePos <= oldest) drop++
    if (drop > 0) anchors.subList(0, drop).clear()
  }

  private fun anchorIndex(pos: Long): Int {
    var lo = 0
    var hi = anchors.size - 1
    while (lo < hi) {
      val mid = (lo + hi + 1) / 2
      if (anchors[mid].framePos <= pos) lo = mid else hi = mid - 1
    }
    return lo
  }

  /** Returns the result and the new cursor. Same semantics as the Swift twin. */
  fun read(cursor: Long, maxFrames: Int, newest: Boolean, dest: FloatArray): Pair<ReadResult, Long> {
    if (anchors.isEmpty() || maxFrames <= 0) {
      return ReadResult(0, cursor, 0.0, 0, false, anchors.lastOrNull()?.rate ?: 0.0) to cursor
    }
    var start = maxOf(cursor, tail)
    if (newest) {
      start = maxOf(start, head - maxFrames)
      val lastBreak = anchors.indexOfLast { it.framePos > start && it.framePos < head && it.disc }
      if (lastBreak >= 0) start = anchors[lastBreak].framePos
    }
    val dropped = maxOf(0L, start - cursor)
    if (start >= head) {
      val a = anchors.last()
      return ReadResult(0, head, a.monoMs + (head - a.framePos) * 1000.0 / a.rate, dropped, false, a.rate) to head
    }
    val ai = anchorIndex(start)
    val a = anchors[ai]
    var end = minOf(head, start + maxFrames)
    var j = ai + 1
    while (j < anchors.size && anchors[j].framePos < end) {
      if (anchors[j].disc || anchors[j].rate != a.rate) {
        end = anchors[j].framePos
        break
      }
      j++
    }
    val n = (end - start).toInt()
    var done = 0
    while (done < n) {
      val idx = ((start + done) % capacity).toInt()
      val k = minOf(n - done, capacity - idx)
      System.arraycopy(buf, idx, dest, done, k)
      done += k
    }
    val r = ReadResult(n, start, a.monoMs + (start - a.framePos) * 1000.0 / a.rate, dropped, a.disc && start == a.framePos, a.rate)
    return r to end
  }

  /** Forgets the time anchors (stop): the next write starts a new burst. */
  fun reset() = anchors.clear()
}
