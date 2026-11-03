/**
 * dbHelper.js — Lapisan memori & konfigurasi bot di atas PostgreSQL.
 *
 * Dipakai oleh semua consumer di bot/*.js untuk memori percakapan,
 * penanda topik + ringkasan, konfigurasi bot dinamis, dan akses pengguna.
 *
 * Koneksi dibuat malas (lazy) saat query pertama; tabel dipastikan ada
 * lewat schema.sql. Set DATABASE_URL di .env, misal:
 *   DATABASE_URL=postgres://user:pass@localhost:5432/nroz
 * Untuk managed DB yang mewajibkan TLS, tambahkan ?sslmode=require.
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const HISTORY_LIMIT = 100; // batas pesan yang diambil untuk history mentah

// === KONEKSI (LAZY) ===
let pool = null;
let readyPromise = null;

function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const connectionString = (process.env.DATABASE_URL || "").trim();
      if (!connectionString) {
        throw new Error("DATABASE_URL belum diisi di .env (contoh: postgres://user:pass@localhost:5432/nroz)");
      }
      pool = new Pool({ connectionString, max: 5 });
      pool.on("error", (err) => console.error("[PostgreSQL] error idle client:", err.message));
      const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
      await pool.query(schema);
    })();
    // Kalau gagal (DB down / env salah), izinkan percobaan ulang di query berikutnya.
    readyPromise.catch(() => { readyPromise = null; });
  }
  return readyPromise;
}

// Hook untuk unit test: mengganti seluruh lapisan query dengan implementasi palsu.
let queryOverride = null;
function __setQueryForTests(fn) {
  queryOverride = fn;
}

/** Query mentah, dipakai test-db.js untuk verifikasi dan bersih-bersih. */
async function query(text, params) {
  if (queryOverride) return queryOverride(text, params);
  await ensureReady();
  return pool.query(text, params);
}

/** Tutup pool (dipakai test / shutdown bersih). */
async function closeDb() {
  if (pool) await pool.end();
  pool = null;
  readyPromise = null;
}

// === UTILITY ===
// Timestamp naik terus (mikrodetik), dipakai buat urutan pesan.
// Angkanya ~1.7e15 jadi masih aman di bawah batas integer JS (9e15).
let lastTs = 0;
function nextTs() {
  lastTs = Math.max(Date.now() * 1000, lastTs + 1);
  return lastTs;
}

// ID dokumen deterministik biar reply context bisa diambil langsung (tanpa filter)
function docId(chatId, telegramMessageId, ts) {
  return telegramMessageId != null
    ? `${chatId}_${telegramMessageId}`
    : `${chatId}_x${ts}`;
}

// node-pg mengembalikan BIGINT sebagai string — paksa ke Number di satu tempat.
function stateFromRow(row) {
  if (!row) return { topic_ts: 0, summary: "", summarized_up_to_ts: 0, is_paused: false };
  return {
    topic_ts: Number(row.topic_ts) || 0,
    summary: row.summary || "",
    summarized_up_to_ts: Number(row.summarized_up_to_ts) || 0,
    is_paused: Boolean(row.is_paused)
  };
}

// === PENANDA TOPIC & SUMMARY (STATE) ===
async function getChatState(chatId) {
  const res = await query("SELECT * FROM chat_state WHERE id = $1", [String(chatId)]);
  return stateFromRow(res.rows[0]);
}

async function getTopicStart(chatId) {
  const state = await getChatState(chatId);
  return state.topic_ts;
}

/**
 * Menyimpan ringkasan secara atomik: update hanya berlaku jika belum ada topik
 * baru setelah upToTs (WHERE topic_ts <= upToTs). Mengembalikan { saved, reason }
 * supaya pemanggil tahu apakah benar-benar tersimpan.
 */
async function updateChatSummary(chatId, summary, upToTs) {
  const res = await query(
    `INSERT INTO chat_state (id, topic_ts, summary, summarized_up_to_ts, is_paused)
     VALUES ($1, 0, $2, $3, false)
     ON CONFLICT (id) DO UPDATE
       SET summary = EXCLUDED.summary, summarized_up_to_ts = EXCLUDED.summarized_up_to_ts
       WHERE chat_state.topic_ts <= EXCLUDED.summarized_up_to_ts
     RETURNING summarized_up_to_ts`,
    [String(chatId), String(summary || ""), Number(upToTs) || 0]
  );

  if (res.rowCount === 0) {
    return { saved: false, reason: "topik baru dibuat setelah pesan yang diringkas (/newtopic saat peringkasan berjalan)" };
  }
  if (Number(res.rows[0].summarized_up_to_ts) !== (Number(upToTs) || 0)) {
    return { saved: false, reason: "database tidak mengonfirmasi data tersimpan" };
  }
  return { saved: true };
}

async function setChatPaused(chatId, isPaused) {
  await query(
    `INSERT INTO chat_state (id, is_paused) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET is_paused = EXCLUDED.is_paused`,
    [String(chatId), Boolean(isPaused)]
  );
}

async function isChatPaused(chatId) {
  const state = await getChatState(chatId);
  return Boolean(state.is_paused);
}

// === FUNGSI UTAMA ===
async function saveMemory(chatId, role, content, telegramMessageId = null) {
  const ts = nextTs();
  await query(
    `INSERT INTO chat_memory (id, chat_id, role, content, ts, telegram_message_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE
       SET role = EXCLUDED.role, content = EXCLUDED.content,
           ts = EXCLUDED.ts, telegram_message_id = EXCLUDED.telegram_message_id`,
    [docId(chatId, telegramMessageId, ts), String(chatId), role, String(content ?? ""), ts, telegramMessageId]
  );
}

// History standar (mentah)
async function getHistory(chatId) {
  const topicStart = await getTopicStart(chatId);
  const res = await query(
    `SELECT role, content FROM chat_memory
     WHERE chat_id = $1 AND ts > $2
     ORDER BY ts DESC LIMIT $3`,
    [String(chatId), topicStart, HISTORY_LIMIT]
  );
  return res.rows.reverse().map((row) => ({ role: row.role, content: row.content }));
}

// History pintar untuk AI (Summary Buffer Memory: Ringkasan lama + N pesan terbaru)
async function getHistoryForAI(chatId, recentLimit = 6) {
  const state = await getChatState(chatId);
  const res = await query(
    `SELECT role, content FROM chat_memory
     WHERE chat_id = $1 AND ts > $2
     ORDER BY ts DESC LIMIT $3`,
    [String(chatId), state.topic_ts, recentLimit]
  );

  const rows = res.rows.reverse();
  const messages = [];

  // Jika ada ringkasan percakapan sebelumnya, masukkan sebagai system prompt di awal
  if (state.summary && state.summary.trim().length > 0) {
    messages.push({
      role: "system",
      content: `[Konteks Memori Percakapan Sebelumnya]:\n${state.summary.trim()}`
    });
  }

  for (const row of rows) {
    messages.push({ role: row.role, content: row.content });
  }

  return messages;
}

// Ambil pesan-pesan yang perlu diringkas jika sudah melewati ambang batas (threshold)
async function getMessagesToSummarize(chatId, keepRecent = 4, threshold = 10) {
  const state = await getChatState(chatId);
  const minTs = Math.max(state.topic_ts, state.summarized_up_to_ts);

  const res = await query(
    `SELECT role, content, ts FROM chat_memory
     WHERE chat_id = $1 AND ts > $2
     ORDER BY ts ASC LIMIT 50`,
    [String(chatId), minTs]
  );

  const rows = res.rows.map((row) => ({ role: row.role, content: row.content, ts: Number(row.ts) }));
  if (rows.length < threshold) return null;

  // Sisakan keepRecent pesan terbaru agar tetap di working memory
  const toSummarize = rows.slice(0, rows.length - keepRecent);
  if (toSummarize.length === 0) return null;

  return {
    currentSummary: state.summary || "",
    messagesToSummarize: toSummarize,
    upToTs: toSummarize[toSummarize.length - 1].ts
  };
}

async function getReplyContext(chatId, messageId) {
  const res = await query(
    "SELECT id, chat_id, role, content, ts, telegram_message_id FROM chat_memory WHERE id = $1",
    [docId(chatId, messageId)]
  );
  const row = res.rows[0];
  if (!row || row.content === undefined) return null;

  // Pesan dari topic lama dianggap sudah terhapus
  const topicStart = await getTopicStart(chatId);
  if (topicStart && Number(row.ts) <= topicStart) return null;

  return { ...row, ts: Number(row.ts) };
}

// Dipanggil /newtopic. Hapus pesan lama satu query — instan, tak butuh background job.
async function newTopic(chatId) {
  const key = String(chatId);
  const ts = nextTs();

  await query(
    `INSERT INTO chat_state (id, topic_ts, summary, summarized_up_to_ts, is_paused)
     VALUES ($1, $2, '', $2, false)
     ON CONFLICT (id) DO UPDATE
       SET topic_ts = EXCLUDED.topic_ts, summary = '',
           summarized_up_to_ts = EXCLUDED.summarized_up_to_ts, is_paused = false`,
    [key, ts]
  );
  await query("DELETE FROM chat_memory WHERE chat_id = $1 AND ts <= $2", [key, ts]);

  // Interface lama mengembalikan { purge } berupa promise bersih-bersih background;
  // di PostgreSQL penghapusan sudah selesai saat fungsi ini kembali.
  return { purge: Promise.resolve() };
}

// === PENGATURAN BOT DINAMIS (MODEL, BASE_URL, API_KEY) ===
async function getBotConfig() {
  const res = await query("SELECT model, base_url, api_key, updated_at FROM bot_config WHERE id = 1");
  const row = res.rows[0];
  if (row && (row.model || row.base_url || row.api_key)) {
    return {
      model: row.model || null,
      baseUrl: row.base_url || null,
      apiKey: row.api_key || null,
      updated_at: row.updated_at != null ? Number(row.updated_at) : null
    };
  }
  return null;
}

async function saveBotConfig(config) {
  const doc = {
    model: config.model || null,
    baseUrl: config.baseUrl || null,
    apiKey: config.apiKey || null,
    updated_at: Date.now()
  };
  await query(
    `INSERT INTO bot_config (id, model, base_url, api_key, updated_at)
     VALUES (1, $1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET model = EXCLUDED.model, base_url = EXCLUDED.base_url,
           api_key = EXCLUDED.api_key, updated_at = EXCLUDED.updated_at`,
    [doc.model, doc.baseUrl, doc.apiKey, doc.updated_at]
  );
  return doc;
}

async function resetBotConfig() {
  await query("DELETE FROM bot_config WHERE id = 1");
}

// === SISTEM AKSES PENGGUNA (APPROVAL / WHITELIST) ===
async function getUserAccess(userId) {
  const res = await query(
    "SELECT user_id, status, name, username, updated_at FROM user_access WHERE user_id = $1",
    [String(userId)]
  );
  const row = res.rows[0];
  if (!row || !row.status) return null;
  return {
    userId: String(userId),
    status: row.status,
    name: row.name || "",
    username: row.username || "",
    updated_at: row.updated_at != null ? Number(row.updated_at) : null
  };
}

async function setUserAccess(userId, status, details = {}) {
  const doc = {
    userId: String(userId),
    status,
    name: details.name || "",
    username: details.username || "",
    updated_at: Date.now()
  };
  await query(
    `INSERT INTO user_access (user_id, status, name, username, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE
       SET status = EXCLUDED.status, name = EXCLUDED.name,
           username = EXCLUDED.username, updated_at = EXCLUDED.updated_at`,
    [doc.userId, doc.status, doc.name, doc.username, doc.updated_at]
  );
  return doc;
}

async function deleteUserAccess(userId) {
  await query("DELETE FROM user_access WHERE user_id = $1", [String(userId)]);
}

module.exports = {
  query,
  closeDb,
  __setQueryForTests,
  saveMemory,
  getHistory,
  getHistoryForAI,
  getReplyContext,
  getChatState,
  updateChatSummary,
  getMessagesToSummarize,
  newTopic,
  getBotConfig,
  saveBotConfig,
  resetBotConfig,
  getUserAccess,
  setUserAccess,
  deleteUserAccess,
  setChatPaused,
  isChatPaused
};
