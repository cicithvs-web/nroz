/**
 * tools/scheduling.js — Tool penjadwalan: create_reminder, create_watchdog, schedule_agent_task.
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
async function toolCreateWatchdog({ url, interval_minutes, auto_heal_task, sessionId, chatId, threadId }) {
  if (!url) return "❌ 'url' wajib diisi.";
  const interval = Number(interval_minutes) || 10;
  let w;
  try {
    w = await scheduler.addWatchdog({
      sessionId: sessionId || "default",
      chatId: chatId ?? scheduler.splitSessionId(sessionId || "default").chatId,
      threadId: threadId ?? null,
      url,
      intervalMinutes: interval,
      autoHealTask: auto_heal_task || null
    });
  } catch (err) {
    if (err instanceof BlockedUrlError) return `⛔ ${err.message}`;
    return `❌ Gagal memasang watchdog: ${err.message}`;
  }
  const healInfo = w.autoHealTask
    ? `\n• Mode Self-Healing: AKTIF — jika down, Agent otomatis bangun & mengeksekusi: "${w.autoHealTask}"`
    : `\n• Mode: Notifikasi peringatan Telegram saat website down/pulih.`;
  return `🚨 Watchdog pemantau server aktif untuk: ${url}\n• Interval pengecekan: Setiap ${interval} menit.${healInfo}`;
}

/**
 * Tool: schedule_agent_task
 * Berbeda dari create_reminder (yang hanya mengirim teks): saat waktunya tiba, agent
 * dibangunkan dengan instruksi ini dan bekerja otonom memakai semua tools, lalu melapor
 * ke chat. Dipakai untuk pekerjaan berkala/mandiri, bukan sekadar pengingat.
 */
async function toolScheduleAgentTask({ task, minutes_from_now, at, repeat, timezone, sessionId, chatId, threadId }) {
  if (!task || !String(task).trim()) return "❌ Parameter 'task' (instruksi tugas) wajib diisi.";
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
      targetTime = Date.now() + mins * 60_000;
    } else {
      return "❌ Isi salah satu: 'minutes_from_now' atau 'at'.";
    }
    if (targetTime <= Date.now()) {
      return `❌ Waktu ${scheduler.formatInZone(targetTime, tz)} sudah lewat. Pilih waktu yang akan datang.`;
    }

    const t = scheduler.addAgentTask({
      sessionId: sessionId || "default",
      chatId: chatId ?? scheduler.splitSessionId(sessionId || "default").chatId,
      threadId: threadId ?? null,
      task,
      targetTime,
      repeat: rep,
      timezone: tz
    });

    const taskPreview = String(task).trim();
    return (
      `🤖 Tugas agent terjadwal berhasil didaftarkan!\n` +
      `• ID: ${t.id}\n` +
      `• Tugas: "${taskPreview.slice(0, 150)}${taskPreview.length > 150 ? "…" : ""}"\n` +
      `• Eksekusi pertama: ${scheduler.formatInZone(t.targetTime, tz)}\n` +
      `• Pengulangan: ${scheduler.REPEAT_LABEL[rep]}\n` +
      `Saat waktunya tiba, kamu akan dibangunkan otomatis dengan instruksi ini untuk dikerjakan ` +
      `sampai tuntas dengan semua tools yang tersedia, dan hasilnya dilaporkan ke chat ini. ` +
      `User bisa melihat/membatalkannya lewat /tasks.`
    );
  } catch (err) {
    return `❌ Gagal menjadwalkan tugas agent: ${err.message}`;
  }
}

module.exports = { toolCreateReminder, toolCreateWatchdog, toolScheduleAgentTask };
