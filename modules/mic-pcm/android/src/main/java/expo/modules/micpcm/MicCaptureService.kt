// Microphone foreground service (D16, SPEC §13): keeps the process — and MicCore's capture — running with the screen
// off. Started by MicCore.start({ background: true }) while the app is visible (while-in-use rule); its ongoing
// notification carries a Stop action that reaches JS as the `stopRequested` event. Registered in the app manifest by
// the app's config plugin (sound-meter: plugins/with-mic-fgs.js), not by this module's manifest.
package expo.modules.micpcm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

class MicCaptureService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      MicCore.onStopRequested()
      return START_NOT_STICKY
    }
    title = intent?.getStringExtra("title") ?: title
    text = intent?.getStringExtra("text") ?: text
    stopLabel = intent?.getStringExtra("stop") ?: stopLabel
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
    ServiceCompat.startForeground(this, NOTIFICATION_ID, build(this), type)
    isRunning = true
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    isRunning = false
    super.onDestroy()
  }

  companion object {
    private const val CHANNEL = "mic-pcm-logging"
    private const val NOTIFICATION_ID = 5710
    private const val ACTION_STOP = "expo.modules.micpcm.STOP"
    @Volatile var isRunning = false
    private var title = "Noise log"
    private var text = "Measuring sound levels"
    private var stopLabel = "Stop"

    private fun build(ctx: Context): Notification {
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
        nm.createNotificationChannel(NotificationChannel(CHANNEL, title, NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
      }
      val stop = PendingIntent.getService(
        ctx, 1, Intent(ctx, MicCaptureService::class.java).setAction(ACTION_STOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      val open = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.let {
        PendingIntent.getActivity(ctx, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }
      return NotificationCompat.Builder(ctx, CHANNEL)
        .setSmallIcon(android.R.drawable.ic_btn_speak_now)
        .setContentTitle(title)
        .setContentText(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .setContentIntent(open)
        .addAction(0, stopLabel, stop)
        .build()
    }

    /** "Logging noise · 41 dB(A) · 2 h 13 min" — needs no POST_NOTIFICATIONS to keep the service alive (D16). */
    fun update(ctx: Context, newText: String) {
      text = newText
      if (!isRunning) return
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      try {
        nm.notify(NOTIFICATION_ID, build(ctx))
      } catch (_: SecurityException) {
      }
    }
  }
}
