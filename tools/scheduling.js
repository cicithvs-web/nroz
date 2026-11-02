/**
 * tools/scheduling.js — Tool penjadwalan: create_reminder, create_watchdog.
 */

const scheduler = require("../schedulerManager.js");
const { BlockedUrlError } = require("../lib/netGuard");

/**
 * Tool: create_reminder
 * Mendukung waktu relatif (minutes_from_now) atau absolut (at), plus pengulangan.
 */
async function toolCreateReminder({ message, minutes_from_now, at, repeat, timezone, sessionId, chatId, threadId }) {
  if (!message || !String(message).trim()) return "❌ 'message' wajib diisi.";
  const tz = timezone || scheduler.DEFAULT_TZ;
  const rep = repeat || "none";
  if (!scheduler.REPEATS.includes(rep)) {
    return `❌ 'repeat' harus salah satu dari: ${scheduler.REPEATS.join(", ")}.`;
  }

  let targetTime;
  try {
    if (at) {
      targetTime = scheduler.parseAt(at, tz);
    } else if (minutes_from_now !== undefined && minutes_from_now !== null && minutes_from_now !== "") {
      const mins = Number(minutes_from_now);
      if (Number.isNaN(mins) || mins <= 0) return "❌ 'minutes_from_now' harus berupa angka positif.";
      targetTime = Date.now() + mins * 60 * 1000;
    } else {
      return "❌ Isi salah satu: 'minutes_from_now' atau 'at'.";
    }
    if (targetTime <= Date.now()) {
      return `❌ Waktu ${scheduler.formatInZone(targetTime, tz)} sudah lewat. Pilih waktu yang akan datang.`;
    }

    const r = scheduler.addReminder({
      sessionId: sessionId || "default",
      chatId: chatId ?? scheduler.splitSessionId(sessionId || "default").chatId,
      threadId: threadId ?? null,
      message,
      targetTime,
      repeat: rep,
      timezone: tz
    });

    return (
      `⏰ Pengingat berhasil dijadwalkan!\n` +
      `• ID: ${r.id}\n` +
      `• Pesan: "${r.message}"\n` +
      `• Waktu: ${scheduler.formatInZone(r.targetTime, tz)}\n` +
      `• Pengulangan: ${scheduler.REPEAT_LABEL[rep]}\n` +
      `User bisa melihat dan membatalkannya lewat /tasks.`
    );
  } catch (err) {
    return `❌ Gagal menjadwalkan pengingat: ${err.message}`;
  }
}

/**
 * Tool: create_watchdog
 */
async function toolCreateWatchdog({ url, interval_minutes, sessionId, chatId, threadId }) {
  if (!url) return "❌ 'url' wajib diisi.";
  const interval = Number(interval_minutes) || 10;
  try {
    await scheduler.addWatchdog({
      sessionId: sessionId || "default",
      chatId: chatId ?? scheduler.splitSessionId(sessionId || "default").chatId,
      threadId: threadId ?? null,
      url,
      intervalMinutes: interval
    });
  } catch (err) {
    if (err instanceof BlockedUrlError) return `⛔ ${err.message}`;
    return `❌ Gagal memasang watchdog: ${err.message}`;
  }
  return `🚨 Watchdog pemantau server aktif untuk: ${url}\n• Interval pengecekan: Setiap ${interval} menit.\nBot akan otomatis mengirimkan peringatan di Telegram jika website down/error.`;
}

module.exports = { toolCreateReminder, toolCreateWatchdog };
