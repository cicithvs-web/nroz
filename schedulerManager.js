/**
 * schedulerManager.js — Pengelola Pengingat (Reminder) & Website Watchdog (Pemantau Server)
 *
 * Fitur:
 * - Pengingat sekali jalan atau berulang (harian, hari kerja, mingguan, bulanan) dengan
 *   waktu relatif ("15 menit lagi") atau absolut ("2026-11-02 08:00" WIB).
 * - Watchdog Pemantau URL/Website: cek status tiap N menit, lapor saat down dan pulih.
 * - Persisten ke scheduler_data.json dengan penulisan atomik (file sementara + rename).
 * - Pengingat baru dihapus/dijadwalkan ulang SETELAH berhasil terkirim.
 */

const path = require("path");
const { writeJsonAtomic, readJsonSafe } = require("./lib/atomicFile");
const { assertPublicUrl, safeFetch } = require("./lib/netGuard");

const DATA_FILE = process.env.SCHEDULER_DATA_FILE || path.join(__dirname, "scheduler_data.json");
const DEFAULT_TZ = "Asia/Jakarta";
const MAX_SEND_ATTEMPTS = 10;
const REPEATS = ["none", "daily", "weekdays", "weekly", "monthly"];

const REPEAT_LABEL = {
  none: "sekali",
  daily: "setiap hari",
  weekdays: "setiap hari kerja (Sen–Jum)",
  weekly: "setiap minggu",
  monthly: "setiap bulan"
};

const TZ_ABBR = { "Asia/Jakarta": "WIB", "Asia/Pontianak": "WIB", "Asia/Makassar": "WITA", "Asia/Jayapura": "WIT" };

let reminders = [];
let watchdogs = [];
let botInstance = null;
let reminderTickRunning = false;
let watchdogTickRunning = false;

// ============================================================
// UTILITAS ZONA WAKTU (tanpa dependensi, memakai Intl)
// ============================================================

function assertTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw new Error(`Zona waktu '${tz}' tidak dikenal. Contoh yang valid: Asia/Jakarta, Asia/Makassar, Asia/Jayapura.`);
  }
}

const partsFormatters = new Map();
function getZonedParts(ms, tz) {
  let fmt = partsFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short"
    });
    partsFormatters.set(tz, fmt);
  }
  const out = {};
  for (const p of fmt.formatToParts(new Date(ms))) out[p.type] = p.value;
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: weekdays[out.weekday]
  };
}

/** Selisih (ms) jam dinding zona `tz` terhadap UTC pada saat `ms`. */
function tzOffsetMs(ms, tz) {
  const p = getZonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Jam dinding (tahun, bulan 1-12, tanggal, jam, menit) di zona `tz` -> epoch ms. */
function zonedWallTimeToUtc({ year, month, day, hour, minute }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let result = guess - tzOffsetMs(guess, tz);
  // Koreksi kedua untuk zona dengan DST (offset bisa berbeda di sekitar `guess`).
  const second = guess - tzOffsetMs(result, tz);
  if (second !== result) result = second;
  return result;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Tambah `n` hari kalender ke tanggal jam dinding, jam/menit tetap. */
function addWallDays(parts, n) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + n));
  return { ...parts, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
}

/**
 * Mengurai waktu absolut.
 *   "YYYY-MM-DD HH:mm" / "YYYY-MM-DDTHH:mm[:ss]" -> jam dinding di zona `tz`
 *   "HH:mm"                                    -> kejadian berikutnya dari jam itu (hari ini/besok)
 *   ISO dengan offset/Z (misal 2026-11-02T08:00:00+07:00) -> dipakai apa adanya
 */
function parseAt(at, tz = DEFAULT_TZ, nowMs = Date.now()) {
  const s = String(at || "").trim();
  if (!s) throw new Error("Parameter 'at' kosong.");

  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) && s.includes("T")) {
    const ms = Date.parse(s);
    if (Number.isNaN(ms)) throw new Error(`Format waktu '${s}' tidak dikenali.`);
    return ms;
  }

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2})[:.](\d{2})(?::\d{2})?$/);
  if (m) {
    const [, y, mo, d, h, mi] = m.map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59) {
      throw new Error(`Tanggal/jam '${s}' tidak valid.`);
    }
    return zonedWallTimeToUtc({ year: y, month: mo, day: d, hour: h, minute: mi }, tz);
  }

  m = s.match(/^(\d{1,2})[:.](\d{2})$/);
  if (m) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) throw new Error(`Jam '${s}' tidak valid.`);
    const today = getZonedParts(nowMs, tz);
    let target = zonedWallTimeToUtc({ ...today, hour: h, minute: mi }, tz);
    if (target <= nowMs) {
      target = zonedWallTimeToUtc({ ...addWallDays(today, 1), hour: h, minute: mi }, tz);
    }
    return target;
  }

  throw new Error(`Format waktu '${s}' tidak dikenali. Pakai 'YYYY-MM-DD HH:mm' atau 'HH:mm'.`);
}

/**
 * Kejadian berikutnya SETELAH `nowMs` untuk pengingat berulang, berdasarkan jam dinding
 * kejadian sebelumnya. Kalau bot sempat mati, jadwal yang terlewat dilompati (tidak dikirim
 * beruntun).
 * @param {number} anchorDay tanggal asli untuk 'monthly' (31 -> akhir bulan di bulan pendek)
 */
function nextOccurrence(prevMs, repeat, tz = DEFAULT_TZ, nowMs = Date.now(), anchorDay = null) {
  if (!repeat || repeat === "none") return null;
  let parts = getZonedParts(prevMs, tz);
  const day0 = anchorDay || parts.day;

  for (let guard = 0; guard < 5000; guard++) {
    if (repeat === "daily") {
      parts = addWallDays(parts, 1);
    } else if (repeat === "weekly") {
      parts = addWallDays(parts, 7);
    } else if (repeat === "weekdays") {
      do {
        parts = addWallDays(parts, 1);
      } while (parts.weekday === 0 || parts.weekday === 6);
    } else if (repeat === "monthly") {
      let year = parts.year;
      let month = parts.month + 1;
      if (month > 12) {
        month = 1;
        year++;
      }
      parts = { ...parts, year, month, day: Math.min(day0, daysInMonth(year, month)) };
    } else {
      throw new Error(`Jenis pengulangan '${repeat}' tidak dikenal.`);
    }
    const ms = zonedWallTimeToUtc(parts, tz);
    if (ms > nowMs) return ms;
  }
  throw new Error("Gagal menghitung jadwal berikutnya.");
}

function formatInZone(ms, tz = DEFAULT_TZ) {
  const text = new Date(ms).toLocaleString("id-ID", {
    timeZone: tz,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  return `${text} ${TZ_ABBR[tz] || tz}`;
}

// ============================================================
// PERSISTENSI
// ============================================================

/** "-100123_t45" -> { chatId: "-100123", threadId: 45 }; chat biasa -> threadId null. */
function splitSessionId(sessionId) {
  const m = String(sessionId).match(/^(-?\d+)_t(\d+)$/);
  return m ? { chatId: m[1], threadId: Number(m[2]) } : { chatId: String(sessionId), threadId: null };
}

/** Data versi lama hanya punya chatId (yang sebenarnya sessionId). */
function normalizeTarget(item) {
  if (!item.sessionId) {
    item.sessionId = String(item.chatId);
    const { chatId, threadId } = splitSessionId(item.chatId);
    item.chatId = chatId;
    if (item.threadId == null) item.threadId = threadId;
  }
  return item;
}

function loadData() {
  const data = readJsonSafe(DATA_FILE, {});
  reminders = (data.reminders || []).map((r) => {
    normalizeTarget(r);
    if (!REPEATS.includes(r.repeat)) r.repeat = "none";
    r.timezone = r.timezone || DEFAULT_TZ;
    r.attempts = r.attempts || 0;
    return r;
  });
  watchdogs = (data.watchdogs || []).map(normalizeTarget);
}

function saveData() {
  try {
    writeJsonAtomic(DATA_FILE, { reminders, watchdogs });
  } catch (err) {
    console.warn("[Scheduler] Gagal menyimpan scheduler_data.json:", err.message);
  }
}

loadData();

// ============================================================
// PENGIRIMAN
// ============================================================

/** Error Telegram yang tidak akan sembuh kalau dicoba lagi. */
function isPermanentSendError(err) {
  const msg = String(err?.message || "");
  return /\b403\b|chat not found|bot was (blocked|kicked)|user is deactivated|have no rights|thread not found|PEER_ID_INVALID/i.test(msg);
}

async function sendWithFallback(chatId, text, opts) {
  try {
    return await botInstance.sendMessage(chatId, text, { parse_mode: "Markdown", ...opts });
  } catch (err) {
    if (!/can't parse entities/i.test(err.message)) throw err;
    const plain = { ...opts };
    delete plain.parse_mode;
    return await botInstance.sendMessage(chatId, text.replace(/[*_`]/g, ""), plain);
  }
}

function targetOpts(item, extra = {}) {
  return item.threadId ? { message_thread_id: item.threadId, ...extra } : { ...extra };
}

function initScheduler(bot) {
  botInstance = bot;
  // unref: interval tidak menahan proses tetap hidup (polling bot yang melakukannya).
  setInterval(() => checkReminders().catch((e) => console.warn("[Scheduler] tick reminder error:", e.message)), 30_000).unref();
  setInterval(() => checkWatchdogs().catch((e) => console.warn("[Scheduler] tick watchdog error:", e.message)), 60_000).unref();
  console.log("[Scheduler] Sistem Pengingat & Watchdog Server aktif.");
}

async function checkReminders(now = Date.now()) {
  if (!botInstance || reminderTickRunning) return;
  reminderTickRunning = true;
  let changed = false;
  try {
    const due = reminders.filter((r) => r.targetTime <= now).sort((a, b) => a.targetTime - b.targetTime);
    for (const r of due) {
      const recurring = r.repeat && r.repeat !== "none";
      let text = `⏰ *PENGINGAT (REMINDER)!*\n\n🔔 ${r.message}`;
      let nextMs = null;
      if (recurring) {
        nextMs = nextOccurrence(r.targetTime, r.repeat, r.timezone, now, r.anchorDay);
        text += `\n\n🔁 ${REPEAT_LABEL[r.repeat]} · berikutnya ${formatInZone(nextMs, r.timezone)}`;
      }
      const opts = targetOpts(r, recurring
        ? { reply_markup: { inline_keyboard: [[{ text: "🛑 Hentikan pengingat ini", callback_data: `task_cancel:${r.id}` }]] } }
        : {});

      try {
        await sendWithFallback(r.chatId, text, opts);
        if (recurring) {
          r.targetTime = nextMs;
          r.attempts = 0;
          r.lastSentAt = now;
        } else {
          reminders = reminders.filter((x) => x.id !== r.id);
        }
        changed = true;
      } catch (err) {
        r.attempts = (r.attempts || 0) + 1;
        changed = true;
        const permanent = isPermanentSendError(err);
        if (permanent || r.attempts >= MAX_SEND_ATTEMPTS) {
          console.warn(`[Scheduler] Pengingat ${r.id} dihapus setelah gagal kirim (${r.attempts}x): ${err.message}`);
          reminders = reminders.filter((x) => x.id !== r.id);
        } else {
          console.warn(`[Scheduler] Gagal kirim pengingat ${r.id} (percobaan ${r.attempts}/${MAX_SEND_ATTEMPTS}), dicoba lagi: ${err.message}`);
        }
      }
    }
  } finally {
    if (changed) saveData();
    reminderTickRunning = false;
  }
}

async function checkWatchdogs(now = Date.now()) {
  if (!botInstance || watchdogTickRunning) return;
  watchdogTickRunning = true;
  let changed = false;
  try {
    for (const w of watchdogs) {
      const intervalMs = (w.intervalMinutes || 10) * 60 * 1000;
      if (now - (w.lastChecked || 0) < intervalMs) continue;

      w.lastChecked = now;
      changed = true;
      let isDown = false;
      let errorDetail = "";

      try {
        const res = await safeFetch(w.url, { method: "GET", signal: AbortSignal.timeout(10_000) });
        if (res.status >= 400) {
          isDown = true;
          errorDetail = `Status code: ${res.status} ${res.statusText}`;
        }
      } catch (err) {
        isDown = true;
        errorDetail = err.message;
      }

      if (isDown && !w.isCurrentlyDown) {
        w.isCurrentlyDown = true;
        try {
          await sendWithFallback(
            w.chatId,
            `🚨 *PERINGATAN SERVER / WEBSITE DOWN!*\n\n` +
              `• Target: ${w.url}\n` +
              `• Masalah: \`${String(errorDetail).replace(/`/g, "'")}\`\n` +
              `• Waktu terdeteksi: ${formatInZone(now)}\n\n` +
              `Bot akan memberitahukanmu kembali saat website kembali normal.`,
            targetOpts(w)
          );
        } catch (_) {}
      } else if (!isDown && w.isCurrentlyDown) {
        w.isCurrentlyDown = false;
        try {
          await sendWithFallback(
            w.chatId,
            `✅ *KABAR BAIK: WEBSITE SUDAH KEMBALI NORMAL!*\n\n` +
              `• Target: ${w.url}\n` +
              `• Waktu pulih: ${formatInZone(now)}`,
            targetOpts(w)
          );
        } catch (_) {}
      }
    }
  } finally {
    if (changed) saveData();
    watchdogTickRunning = false;
  }
}

// ============================================================
// API
// ============================================================

/**
 * Menambahkan pengingat.
 * @param {object} o
 * @param {string} o.sessionId  sesi pemilik (dipakai /tasks dan pembatalan)
 * @param {string|number} o.chatId  chat tujuan
 * @param {number} [o.threadId]  topic forum tujuan
 * @param {string} o.message
 * @param {number} o.targetTime  epoch ms
 * @param {string} [o.repeat="none"]
 * @param {string} [o.timezone="Asia/Jakarta"]
 */
function addReminder({ sessionId, chatId, threadId = null, message, targetTime, repeat = "none", timezone = DEFAULT_TZ }) {
  if (!REPEATS.includes(repeat)) throw new Error(`repeat harus salah satu dari: ${REPEATS.join(", ")}`);
  assertTimezone(timezone);
  const reminder = {
    id: `rem_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    sessionId: String(sessionId ?? chatId),
    chatId: String(chatId ?? splitSessionId(sessionId).chatId),
    threadId: threadId ?? null,
    message: String(message).trim(),
    targetTime: Number(targetTime),
    repeat,
    timezone,
    anchorDay: repeat === "monthly" ? getZonedParts(Number(targetTime), timezone).day : null,
    attempts: 0,
    createdAt: Date.now()
  };
  reminders.push(reminder);
  saveData();
  return reminder;
}

/**
 * Menambahkan watchdog. URL ke alamat internal (localhost, IP privat, metadata cloud) ditolak.
 */
async function addWatchdog({ sessionId, chatId, threadId = null, url, intervalMinutes = 10 }) {
  const cleanUrl = String(url).trim();
  await assertPublicUrl(cleanUrl);
  const sid = String(sessionId ?? chatId);
  const interval = Math.max(1, Number(intervalMinutes) || 10);

  const existing = watchdogs.find((w) => w.sessionId === sid && w.url === cleanUrl);
  if (existing) {
    existing.intervalMinutes = interval;
    saveData();
    return existing;
  }

  const watchdog = {
    id: `wd_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    sessionId: sid,
    chatId: String(chatId ?? splitSessionId(sid).chatId),
    threadId: threadId ?? null,
    url: cleanUrl,
    intervalMinutes: interval,
    lastChecked: 0,
    isCurrentlyDown: false,
    createdAt: Date.now()
  };
  watchdogs.push(watchdog);
  saveData();
  return watchdog;
}

function listTasks(sessionId) {
  const sid = String(sessionId);
  return {
    reminders: reminders.filter((r) => r.sessionId === sid).sort((a, b) => a.targetTime - b.targetTime),
    watchdogs: watchdogs.filter((w) => w.sessionId === sid)
  };
}

function getTask(id) {
  return reminders.find((r) => r.id === id) || watchdogs.find((w) => w.id === id) || null;
}

function removeTask(sessionId, id) {
  const sid = String(sessionId);
  const beforeR = reminders.length;
  const beforeW = watchdogs.length;

  reminders = reminders.filter((r) => !(r.sessionId === sid && r.id === id));
  watchdogs = watchdogs.filter((w) => !(w.sessionId === sid && w.id === id));

  const removed = beforeR !== reminders.length || beforeW !== watchdogs.length;
  if (removed) saveData();
  return removed;
}

module.exports = {
  initScheduler,
  addReminder,
  addWatchdog,
  listTasks,
  getTask,
  removeTask,
  // diekspor untuk tool, tampilan /tasks, dan unit test
  DEFAULT_TZ,
  REPEATS,
  REPEAT_LABEL,
  parseAt,
  nextOccurrence,
  formatInZone,
  zonedWallTimeToUtc,
  getZonedParts,
  splitSessionId,
  checkReminders,
  _reloadForTests: loadData
};
