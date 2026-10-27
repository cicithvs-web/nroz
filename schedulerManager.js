/**
 * schedulerManager.js — Pengelola Pengingat (Reminder) & Website Watchdog (Pemantau Server)
 *
 * Fitur:
 * - Menjadwalkan pengingat (Reminder): kirim pesan ke Telegram saat waktu tiba.
 * - Watchdog Pemantau URL/Website: otomatis cek status web tiap N menit, lapor jika down.
 * - Persistent ke file scheduler_data.json agar tidak hilang saat bot restart.
 */

const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "scheduler_data.json");

let reminders = [];
let watchdogs = [];
let botInstance = null;

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      reminders = data.reminders || [];
      watchdogs = data.watchdogs || [];
    }
  } catch (err) {
    console.warn("[Scheduler] Gagal membaca scheduler_data.json:", err.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ reminders, watchdogs }, null, 2), "utf-8");
  } catch (err) {
    console.warn("[Scheduler] Gagal menyimpan scheduler_data.json:", err.message);
  }
}

loadData();

function initScheduler(bot) {
  botInstance = bot;
  // Interval cek reminder setiap 30 detik
  setInterval(checkReminders, 30_000);
  // Interval cek watchdog setiap 60 detik
  setInterval(checkWatchdogs, 60_000);
  console.log("[Scheduler] Sistem Pengingat & Watchdog Server aktif.");
}

async function checkReminders() {
  if (!botInstance) return;
  const now = Date.now();
  const due = [];
  const remaining = [];

  for (const r of reminders) {
    if (r.targetTime <= now) {
      due.push(r);
    } else {
      remaining.push(r);
    }
  }

  if (due.length > 0) {
    reminders = remaining;
    saveData();

    for (const r of due) {
      try {
        await botInstance.sendMessage(
          r.chatId,
          `⏰ *PENGINGAT (REMINDER)!*\n\n🔔 ${r.message}`,
          { parse_mode: "Markdown" }
        );
      } catch (err) {
        console.warn(`[Scheduler] Gagal kirim reminder ke ${r.chatId}:`, err.message);
      }
    }
  }
}

async function checkWatchdogs() {
  if (!botInstance) return;
  const now = Date.now();

  for (const w of watchdogs) {
    const intervalMs = (w.intervalMinutes || 10) * 60 * 1000;
    if (now - (w.lastChecked || 0) < intervalMs) continue;

    w.lastChecked = now;
    let isDown = false;
    let errorDetail = "";

    try {
      const res = await fetch(w.url, {
        method: "GET",
        signal: AbortSignal.timeout(10_000)
      });

      if (res.status >= 400) {
        isDown = true;
        errorDetail = `Status code: ${res.status} ${res.statusText}`;
      }
    } catch (err) {
      isDown = true;
      errorDetail = err.message;
    }

    // Jika status berubah dari UP -> DOWN
    if (isDown && !w.isCurrentlyDown) {
      w.isCurrentlyDown = true;
      saveData();
      try {
        await botInstance.sendMessage(
          w.chatId,
          `🚨 *PERINGATAN SERVER / WEBSITE DOWN!*\n\n` +
          `• Target: ${w.url}\n` +
          `• Masalah: \`${errorDetail}\`\n` +
          `• Waktu terdeteksi: ${new Date().toLocaleString("id-ID")}\n\n` +
          `Bot akan memberitahukanmu kembali saat website kembali normal.`,
          { parse_mode: "Markdown" }
        );
      } catch (_) {}
    } else if (!isDown && w.isCurrentlyDown) {
      // Pulih kembali dari DOWN -> UP
      w.isCurrentlyDown = false;
      saveData();
      try {
        await botInstance.sendMessage(
          w.chatId,
          `✅ *KABAR BAIK: WEBSITE SUDAH KEMBALI NORMAL!*\n\n` +
          `• Target: ${w.url}\n` +
          `• Waktu pulih: ${new Date().toLocaleString("id-ID")}`,
          { parse_mode: "Markdown" }
        );
      } catch (_) {}
    }
  }
  saveData();
}

/**
 * Menambahkan Pengingat
 * @param {string|number} chatId
 * @param {string} message
 * @param {number} targetTimeMs - Waktu dalam epoch timestamp ms
 * @returns {object} reminder object
 */
function addReminder(chatId, message, targetTimeMs) {
  const reminder = {
    id: `rem_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    chatId: String(chatId),
    message: String(message).trim(),
    targetTime: Number(targetTimeMs),
    createdAt: Date.now()
  };
  reminders.push(reminder);
  saveData();
  return reminder;
}

/**
 * Menambahkan Watchdog Pemantau Website/Server
 * @param {string|number} chatId
 * @param {string} url
 * @param {number} intervalMinutes
 * @returns {object} watchdog object
 */
function addWatchdog(chatId, url, intervalMinutes = 10) {
  // Cek apakah url sudah dipantau untuk chat ini
  const existing = watchdogs.find((w) => w.chatId === String(chatId) && w.url === url);
  if (existing) {
    existing.intervalMinutes = intervalMinutes;
    saveData();
    return existing;
  }

  const watchdog = {
    id: `wd_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    chatId: String(chatId),
    url: String(url).trim(),
    intervalMinutes: Math.max(1, Number(intervalMinutes) || 10),
    lastChecked: 0,
    isCurrentlyDown: false,
    createdAt: Date.now()
  };
  watchdogs.push(watchdog);
  saveData();
  return watchdog;
}

function listTasks(chatId) {
  const cId = String(chatId);
  const userReminders = reminders.filter((r) => r.chatId === cId);
  const userWatchdogs = watchdogs.filter((w) => w.chatId === cId);
  return { reminders: userReminders, watchdogs: userWatchdogs };
}

function removeTask(chatId, id) {
  const cId = String(chatId);
  const beforeR = reminders.length;
  const beforeW = watchdogs.length;

  reminders = reminders.filter((r) => !(r.chatId === cId && r.id === id));
  watchdogs = watchdogs.filter((w) => !(w.chatId === cId && w.id === id));

  const removed = (beforeR !== reminders.length) || (beforeW !== watchdogs.length);
  if (removed) saveData();
  return removed;
}

module.exports = {
  initScheduler,
  addReminder,
  addWatchdog,
  listTasks,
  removeTask
};
