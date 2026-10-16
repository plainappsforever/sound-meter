// Dev-only deterministic signals (D24, SyntheticSpec in src/MicPcm.types.ts); twin of ios/Synth.swift. They REPLACE the
// microphone samples in the capture loop, so timing, ring buffer and delivery stay the real ones.
package expo.modules.micpcm

import kotlin.math.PI
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

class Synth private constructor(private val rate: Double, private val gen: (Long) -> Double) {
  fun fill(out: FloatArray, n: Int, index: Long) {
    for (i in 0 until n) out[i] = gen(index + i).toFloat()
  }

  companion object {
    private fun sineAmp(rmsDbfs: Double) = sqrt(2.0) * 10.0.pow(rmsDbfs / 20.0)
    private fun num(m: Map<*, *>, k: String) = (m[k] as? Number)?.toDouble()

    fun create(spec: Map<String, Any?>, rate: Double): Synth? {
      val w = 2 * PI / rate
      return when (spec["kind"]) {
        "sine" -> {
          val hz = num(spec, "hz") ?: return null
          val a = sineAmp(num(spec, "rmsDbfs") ?: return null)
          Synth(rate) { k -> a * sin(w * hz * k) }
        }
        "multitone" -> {
          val tones = (spec["tones"] as? List<*>)?.mapNotNull { t ->
            val m = t as? Map<*, *> ?: return@mapNotNull null
            val hz = num(m, "hz") ?: return@mapNotNull null
            val r = num(m, "rmsDbfs") ?: return@mapNotNull null
            hz to sineAmp(r)
          } ?: return null
          Synth(rate) { k -> tones.sumOf { (hz, a) -> a * sin(w * hz * k) } }
        }
        "burst" -> {
          val hz = num(spec, "hz") ?: return null
          val a = sineAmp(num(spec, "rmsDbfs") ?: return null)
          val burst = ((num(spec, "burstMs") ?: return null) * rate / 1000).toLong()
          val every = maxOf(1L, ((num(spec, "everyMs") ?: return null) * rate / 1000).toLong())
          Synth(rate) { k -> if (k % every < burst) a * sin(w * hz * k) else 0.0 }
        }
        "silence" -> {
          val a = sqrt(3.0) * 10.0.pow((num(spec, "rmsDbfs") ?: return null) / 20.0)
          var seed = 0x12345678L
          Synth(rate) { _ ->
            seed = (seed * 1664525L + 1013904223L) and 0xFFFFFFFFL
            a * (seed.toDouble() / 0xFFFFFFFFL.toDouble() * 2 - 1)
          }
        }
        "zeros" -> Synth(rate) { 0.0 }
        "script" -> {
          val steps = (spec["steps"] as? List<*>)?.mapNotNull { s ->
            val m = s as? Map<*, *> ?: return@mapNotNull null
            val sec = num(m, "seconds") ?: return@mapNotNull null
            val r = num(m, "rmsDbfs") ?: return@mapNotNull null
            Triple((sec * rate).toLong(), sineAmp(r), num(m, "hz") ?: 1000.0)
          } ?: return null
          val loop = spec["loop"] as? Boolean ?: false
          val total = steps.sumOf { it.first }
          Synth(rate) { idx ->
            var k = idx
            if (loop && total > 0) k %= total
            var acc = 0L
            var amp = 0.0
            var hz = 1000.0
            for ((frames, a, f) in steps) {
              if (k < acc + frames) {
                amp = a
                hz = f
                break
              }
              acc += frames
            }
            amp * sin(w * hz * idx)
          }
        }
        else -> null
      }
    }
  }
}
