require("dotenv").config();

// === KONFIGURASI ===
const BASE = (process.env.ONLYX_DB_URL || "https://onlyx.top/v1/db/db_ecenheadqyu0").replace(/\/+$/, "");
const KEY = process.env.ONLYX_DB_KEY;

const MEMORY = "chat_memory";   // 1 dokumen = 1 pesan (user / assistant)
const STATE = "chat_state";     // 1 dokumen per chat, nyimpen penanda "topic baru"
const HISTORY_LIMIT = 100;      // sama seperti versi Supabase
const MAX_DOC_BYTES = 900_000;  // batas Onlyx 1MB per dokumen, sisain ruang aman
const PURGE_DELAY_MS = 300;     // ~200 request/menit saat bersih-bersih (limit 300/menit)

if (!KEY) {
  console.warn("[Onlyx DB] ONLYX_DB_KEY belum diisi di .env");
}

// === UTILITY ===
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

class OnlyxError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "OnlyxError";
    this.status = status;
  }
}

// Request dasar ke Onlyx DB. Auto-retry kalau kena rate limit (429).
async function db(method, path, body, attempt = 0) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: "Bearer " + KEY,
      "Content-Type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });

  if (res.status === 429 && attempt < 3) {
    const retryAfter = Number(res.headers.get("retry-after")) || 2 * (attempt + 1);
    await sleep(Math.min(retryAfter, 30) * 1000);
    return db(method, path, body, attempt + 1);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // body kosong (misal DELETE) — aman diabaikan
  }

  if (!res.ok) {
    throw new OnlyxError((data && data.error) || `HTTP ${res.status}`, res.status);
  }
  return data;
}

// Jaga-jaga kalau dokumen dikembalikan terbungkus { id, data: {...} }
function unwrap(row) {
  for (let i = 0; i < 2; i++) {
    if (
      row && typeof row === "object" &&
      row.role === undefined && row.topic_ts === undefined &&
      row.data && typeof row.data === "object" && !Array.isArray(row.data)
    ) {
      row = { ...row.data, id: row.id ?? row.data.id };
    }
  }
  return row;
}

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

// Pastikan dokumen < batas 1MB (file ZIP/PDF besar bisa melebihi)
function fitDoc(doc) {
  let size = Buffer.byteLength(JSON.stringify(doc));
  if (size <= MAX_DOC_BYTES) return doc;

  const note = "\n\n[...dipotong: melebihi batas 1MB per dokumen database]";
  let text = doc.content;
  while (size > MAX_DOC_BYTES && text.length > 0) {
    text = text.slice(0, Math.floor(text.length * 0.85));
    doc.content = text + note;
    size = Buffer.byteLength(JSON.stringify(doc));
  }
  return doc;
}

// === PENANDA TOPIC ===
// === PENANDA TOPIC & SUMMARY (STATE) ===
// Onlyx belum punya "hapus banyak sekaligus", jadi /newtopic nyimpen penanda waktu.
// History cuma ngambil pesan setelah penanda → efeknya instan. Pesan lama dihapus
// pelan-pelan di background.
const stateCache = new Map();

async function getChatState(chatId) {
  const key = String(chatId);
  if (stateCache.has(key)) return stateCache.get(key);

  try {
    const row = unwrap(await db("GET", `/${STATE}/${enc(key)}`));
    const state = {
      topic_ts: Number(row && row.topic_ts) || 0,
      summary: (row && row.summary) || "",
      summarized_up_to_ts: Number(row && row.summarized_up_to_ts) || 0,
      is_paused: Boolean(row && row.is_paused)
    };
    stateCache.set(key, state);
    return state;
  } catch (err) {
    if (err.status === 404) {
      const empty = { topic_ts: 0, summary: "", summarized_up_to_ts: 0, is_paused: false };
      stateCache.set(key, empty);
      return empty;
    }
    console.warn("[Onlyx DB] gagal baca penanda topic & state:", err.message);
    return { topic_ts: 0, summary: "", summarized_up_to_ts: 0, is_paused: false };
  }
}

async function getTopicStart(chatId) {
  const state = await getChatState(chatId);
  return state.topic_ts;
}

async function updateChatSummary(chatId, summary, upToTs) {
  const key = String(chatId);
  const current = await getChatState(chatId);
  // Pastikan tidak menimpa jika topik baru sudah dibuat setelah upToTs
  if (current.topic_ts > upToTs) return;

  const updated = {
    id: key,
    topic_ts: current.topic_ts,
    summary: String(summary || ""),
    summarized_up_to_ts: Number(upToTs) || 0,
    is_paused: Boolean(current.is_paused)
  };
  stateCache.set(key, updated);
  await db("POST", `/${STATE}?upsert=true`, updated);
}

async function setChatPaused(chatId, isPaused) {
  const key = String(chatId);
  const current = await getChatState(chatId);
  const updated = {
    ...current,
    id: key,
    is_paused: Boolean(isPaused)
  };
  stateCache.set(key, updated);
  await db("POST", `/${STATE}?upsert=true`, updated);
}

async function isChatPaused(chatId) {
  const state = await getChatState(chatId);
  return Boolean(state.is_paused);
}

// === FUNGSI UTAMA (nama & bentuknya sama kayak supabaseHelper.js) ===
async function saveMemory(chatId, role, content, telegramMessageId = null) {
  const ts = nextTs();
  const doc = {
    id: docId(chatId, telegramMessageId, ts),
    chat_id: String(chatId),
    role,
    content: String(content ?? ""),
    ts
  };
  if (telegramMessageId != null) doc.telegram_message_id = telegramMessageId;

  await db("POST", `/${MEMORY}?upsert=true`, fitDoc(doc));
}

// History standar (mentah)
async function getHistory(chatId) {
  const topicStart = await getTopicStart(chatId);

  const params = new URLSearchParams({
    chat_id: `eq.${chatId}`,
    order: "ts.desc",
    limit: String(HISTORY_LIMIT)
  });
  if (topicStart) params.set("ts", `gt.${topicStart}`);

  let res;
  try {
    res = await db("GET", `/${MEMORY}?${params}`);
  } catch (err) {
    if (err.status === 404) return []; // collection belum ada
    throw err;
  }

  return ((res && res.data) || [])
    .map(unwrap)
    .reverse()
    .map((row) => ({ role: row.role, content: row.content }));
}

// History pintar untuk AI (Summary Buffer Memory: Ringkasan lama + N pesan terbaru)
async function getHistoryForAI(chatId, recentLimit = 6) {
  const state = await getChatState(chatId);

  const params = new URLSearchParams({
    chat_id: `eq.${chatId}`,
    order: "ts.desc",
    limit: String(recentLimit)
  });
  if (state.topic_ts) params.set("ts", `gt.${state.topic_ts}`);

  let res;
  try {
    res = await db("GET", `/${MEMORY}?${params}`);
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }

  const rows = ((res && res.data) || []).map(unwrap).reverse();
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

  const params = new URLSearchParams({
    chat_id: `eq.${chatId}`,
    order: "ts.asc",
    limit: "50"
  });
  if (minTs) params.set("ts", `gt.${minTs}`);

  let res;
  try {
    res = await db("GET", `/${MEMORY}?${params}`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }

  const rows = ((res && res.data) || []).map(unwrap);
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
  try {
    const row = unwrap(await db("GET", `/${MEMORY}/${enc(docId(chatId, messageId))}`));
    if (!row || row.content === undefined) return null;

    // Pesan dari topic lama dianggap sudah terhapus
    const topicStart = await getTopicStart(chatId);
    if (topicStart && Number(row.ts) <= topicStart) return null;

    return row;
  } catch {
    return null;
  }
}

// Dipanggil /newtopic. Return { purge } — promise bersih-bersih di background
async function newTopic(chatId) {
  const key = String(chatId);
  const ts = nextTs();

  const resetState = { id: key, topic_ts: ts, summary: "", summarized_up_to_ts: ts, is_paused: false };
  stateCache.set(key, resetState);
  await db("POST", `/${STATE}?upsert=true`, resetState);

  const purge = purgeOldMessages(key, ts).catch((err) =>
    console.error("[Onlyx DB] bersih-bersih pesan lama gagal:", err.message)
  );
  return { purge };
}

// Hapus pesan lama satu-satu, dikasih jeda biar gak kena limit 300 request/menit.
const purgeUntil = new Map();

function purgeOldMessages(chatId, beforeTs) {
  const running = purgeUntil.has(chatId);
  purgeUntil.set(chatId, beforeTs); // kalau /newtopic dipanggil lagi, target ikut maju
  if (running) return Promise.resolve();

  return (async () => {
    let failures = 0;
    try {
      for (;;) {
        const params = new URLSearchParams({
          chat_id: `eq.${chatId}`,
          ts: `lte.${purgeUntil.get(chatId)}`,
          limit: "200"
        });

        let rows;
        try {
          rows = ((await db("GET", `/${MEMORY}?${params}`)) || {}).data || [];
        } catch (err) {
          if (err.status === 404) return; // collection belum ada
          throw err;
        }
        if (rows.length === 0) return;

        for (const row of rows) {
          const id = row.id ?? unwrap(row).id;
          try {
            await db("DELETE", `/${MEMORY}/${enc(id)}`);
          } catch (err) {
            if (err.status !== 404) failures++;
          }
          await sleep(PURGE_DELAY_MS);
        }

        if (failures > 10) throw new Error("terlalu banyak gagal hapus, dihentikan");
      }
    } finally {
      purgeUntil.delete(chatId);
    }
  })();
}

// === PENGATURAN BOT DINAMIS (MODEL, BASE_URL, API_KEY) ===
const CONFIG_DOC_ID = "bot_config";

async function getBotConfig() {
  try {
    const row = unwrap(await db("GET", `/${STATE}/${enc(CONFIG_DOC_ID)}`));
    if (row && typeof row === "object" && (row.model || row.baseUrl || row.apiKey)) {
      return {
        model: row.model || null,
        baseUrl: row.baseUrl || null,
        apiKey: row.apiKey || null,
        updated_at: row.updated_at || null
      };
    }
    return null;
  } catch (err) {
    if (err.status === 404) return null;
    console.warn("[Onlyx DB] gagal baca bot_config:", err.message);
    return null;
  }
}

async function saveBotConfig(config) {
  const doc = {
    id: CONFIG_DOC_ID,
    model: config.model || null,
    baseUrl: config.baseUrl || null,
    apiKey: config.apiKey || null,
    updated_at: Date.now()
  };
  await db("POST", `/${STATE}?upsert=true`, doc);
  return doc;
}

async function resetBotConfig() {
  try {
    await db("DELETE", `/${STATE}/${enc(CONFIG_DOC_ID)}`);
  } catch (err) {
    if (err.status !== 404) {
      console.warn("[Onlyx DB] gagal reset bot_config:", err.message);
    }
  }
}

// === SISTEM AKSES PENGGUNA (APPROVAL / WHITELIST) ===
async function getUserAccess(userId) {
  const key = `user_${userId}`;
  if (stateCache.has(key)) return stateCache.get(key);

  try {
    const row = unwrap(await db("GET", `/${STATE}/${enc(key)}`));
    if (row && typeof row === "object" && row.status) {
      const data = {
        userId: String(userId),
        status: row.status,
        name: row.name || "",
        username: row.username || "",
        updated_at: row.updated_at || null
      };
      stateCache.set(key, data);
      return data;
    }
    return null;
  } catch (err) {
    if (err.status === 404) return null;
    console.warn("[Onlyx DB] gagal baca user_access:", err.message);
    return null;
  }
}

async function setUserAccess(userId, status, details = {}) {
  const key = `user_${userId}`;
  const doc = {
    id: key,
    role: "user_access",
    status,
    name: details.name || "",
    username: details.username || "",
    updated_at: Date.now()
  };
  stateCache.set(key, { userId: String(userId), status, ...details, updated_at: doc.updated_at });
  await db("POST", `/${STATE}?upsert=true`, doc);
  return doc;
}

async function deleteUserAccess(userId) {
  const key = `user_${userId}`;
  stateCache.delete(key);
  try {
    await db("DELETE", `/${STATE}/${enc(key)}`);
  } catch (err) {
    if (err.status !== 404) {
      console.warn("[Onlyx DB] gagal hapus user_access:", err.message);
    }
  }
}

module.exports = {
  db,
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
