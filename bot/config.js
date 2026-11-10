/**
 * bot/config.js — Pengaturan model/Base URL/API key dan client OpenAI aktif.
 *
 * Urutan prioritas: .env < config.json lokal < tabel bot_config di PostgreSQL.
 */

const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { getBotConfig } = require("../dbHelper.js");
const { ROOT_DIR } = require("../lib/paths");

const OWNER_ID = process.env.OWNER_ID ? String(process.env.OWNER_ID).trim() : "7368157605";
const CONFIG_FILE = path.join(ROOT_DIR, "config.json");

// Bot API menolak upload > 50 MB, jadi video di atas ambang ini dikirim sebagai link unduhan.
const TELEGRAM_SEND_MAX_MB = Number(process.env.TELEGRAM_SEND_MAX_MB) || 48;

/**
 * Mengurai string daftar model cadangan (dipisah spasi atau koma) menjadi array nama model unik.
 */
function parseFallbackModels(raw) {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/);
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const clean = String(item || "").trim();
    if (!clean || /^(off|none|clear|-)$/i.test(clean)) continue;
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

const defaultConfig = {
  apiKey: process.env.API_KEY || "",
  baseUrl: (process.env.BASE_URL || "").replace(/\/+$/, ""),
  model: process.env.MODEL || "",
  fallbackModels: parseFallbackModels(process.env.FALLBACK_MODEL || "")
};

let currentConfig = { ...defaultConfig, fallbackModels: [...defaultConfig.fallbackModels] };

// Baca dari config.json lokal jika ada (agar langsung siap saat bot start)
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const local = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    if (local.apiKey) currentConfig.apiKey = local.apiKey;
    if (local.baseUrl) currentConfig.baseUrl = local.baseUrl.replace(/\/+$/, "");
    if (local.model) currentConfig.model = local.model;
    if (local.fallbackModels !== undefined) {
      currentConfig.fallbackModels = parseFallbackModels(local.fallbackModels);
    }
  }
} catch (e) {
  console.warn("[Config] Gagal membaca config.json lokal:", e.message);
}

let client = new OpenAI({ apiKey: currentConfig.apiKey, baseURL: currentConfig.baseUrl });

function refreshClient() {
  client = new OpenAI({ apiKey: currentConfig.apiKey, baseURL: currentConfig.baseUrl });
}

function saveLocalConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (e) {
    console.warn("[Config] Gagal menyimpan config.json lokal:", e.message);
  }
}

/** Sinkronisasi dari PostgreSQL saat startup. */
async function syncConfigFromDb() {
  try {
    const remote = await getBotConfig();
    if (remote) {
      if (remote.apiKey) currentConfig.apiKey = remote.apiKey;
      if (remote.baseUrl) currentConfig.baseUrl = remote.baseUrl.replace(/\/+$/, "");
      if (remote.model) currentConfig.model = remote.model;
      if (remote.fallbackModels !== null && remote.fallbackModels !== undefined) {
        currentConfig.fallbackModels = parseFallbackModels(remote.fallbackModels);
      }
      refreshClient();
      saveLocalConfig();
      const fbInfo = currentConfig.fallbackModels?.length
        ? `, Fallback: ${currentConfig.fallbackModels.join(" -> ")}`
        : "";
      console.log(`[Config] Pengaturan sinkron dari PostgreSQL (Model: ${currentConfig.model}${fbInfo})`);
    } else {
      console.log(`[Config] Menggunakan pengaturan default (Model: ${currentConfig.model})`);
    }
  } catch (err) {
    console.warn("[Config] Gagal sinkronisasi DB saat startup:", err.message);
  }
}

function getConfig() {
  return currentConfig;
}

function getClient() {
  return client;
}

/** Mengubah sebagian pengaturan, membuat ulang client kalau perlu, lalu menyimpan lokal. */
function updateConfig(patch) {
  const normalized = { ...patch };
  if (normalized.fallbackModels !== undefined) {
    normalized.fallbackModels = parseFallbackModels(normalized.fallbackModels);
  }
  currentConfig = { ...currentConfig, ...normalized };
  if (patch.apiKey !== undefined || patch.baseUrl !== undefined) refreshClient();
  saveLocalConfig();
  return currentConfig;
}

function resetConfig() {
  currentConfig = { ...defaultConfig, fallbackModels: parseFallbackModels(process.env.FALLBACK_MODEL || "") };
  refreshClient();
  saveLocalConfig();
  return currentConfig;
}

function maskKey(key) {
  if (!key) return "(belum diatur)";
  if (key.length <= 10) return "********";
  return key.slice(0, 7) + "..." + key.slice(-4);
}

function isOwner(msg) {
  const senderId = String(msg.from?.id || "");
  return Boolean(OWNER_ID) && senderId === OWNER_ID;
}

/**
 * Deteksi apakah error API LLM bersifat sementara (timeout, jaringan putus, 429, 5xx)
 * sehingga layak di-retry secara otomatis.
 */
function isTransientApiError(err) {
  const status = Number(err?.status || err?.statusCode || 0);
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return true;
  const msg = String(err?.message || err || "");
  return /timed?\s*out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|rate limit|overloaded|\b(502|503|504|520|522|524)\b/i.test(
    msg
  );
}

/**
 * Memanggil client.chat.completions.create dengan Exponential Backoff Auto-Retry
 * serta opsi FALLBACK_MODEL otomatis jika percobaan utama tetap gagal.
 */
async function createChatCompletionWithRetry(
  activeClient,
  params,
  { maxAttempts = 3, baseDelayMs = 1500, label = "AI" } = {}
) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await activeClient.chat.completions.create(params);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && isTransientApiError(err)) {
        const waitMs = baseDelayMs * Math.pow(2, attempt - 1);
        console.warn(
          `[${label} Retry] Percobaan ${attempt}/${maxAttempts} gagal (${err.message}); mencoba ulang dalam ${waitMs}ms...`
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      break;
    }
  }

  const configuredFallbacks =
    currentConfig.fallbackModels && currentConfig.fallbackModels.length > 0
      ? currentConfig.fallbackModels
      : parseFallbackModels(process.env.FALLBACK_MODEL || "");
  const fallbackList = configuredFallbacks.filter((m) => m && m !== params.model);

  for (let i = 0; i < fallbackList.length; i++) {
    const fbModel = fallbackList[i];
    try {
      console.warn(
        `[${label} Fallback ${i + 1}/${fallbackList.length}] Model '${params.model}' gagal (${lastErr?.message}); mencoba '${fbModel}'...`
      );
      const res = await activeClient.chat.completions.create({ ...params, model: fbModel });
      console.log(`[${label} Fallback] ✅ Berhasil dijawab menggunakan model cadangan '${fbModel}'.`);
      return res;
    } catch (fbErr) {
      lastErr = fbErr;
      console.warn(`[${label} Fallback ${i + 1}/${fallbackList.length}] Model cadangan '${fbModel}' juga gagal: ${fbErr.message}`);
    }
  }

  throw lastErr;
}

module.exports = {
  OWNER_ID,
  TELEGRAM_SEND_MAX_MB,
  getConfig,
  getClient,
  updateConfig,
  resetConfig,
  syncConfigFromDb,
  maskKey,
  isOwner,
  parseFallbackModels,
  isTransientApiError,
  createChatCompletionWithRetry
};
