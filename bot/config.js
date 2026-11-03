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

const defaultConfig = {
  apiKey: process.env.API_KEY || "",
  baseUrl: (process.env.BASE_URL || "").replace(/\/+$/, ""),
  model: process.env.MODEL || ""
};

let currentConfig = { ...defaultConfig };

// Baca dari config.json lokal jika ada (agar langsung siap saat bot start)
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const local = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    if (local.apiKey) currentConfig.apiKey = local.apiKey;
    if (local.baseUrl) currentConfig.baseUrl = local.baseUrl.replace(/\/+$/, "");
    if (local.model) currentConfig.model = local.model;
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
      refreshClient();
      saveLocalConfig();
      console.log(`[Config] Pengaturan sinkron dari PostgreSQL (Model: ${currentConfig.model})`);
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
  currentConfig = { ...currentConfig, ...patch };
  if (patch.apiKey !== undefined || patch.baseUrl !== undefined) refreshClient();
  saveLocalConfig();
  return currentConfig;
}

function resetConfig() {
  currentConfig = { ...defaultConfig };
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

module.exports = {
  OWNER_ID,
  TELEGRAM_SEND_MAX_MB,
  getConfig,
  getClient,
  updateConfig,
  resetConfig,
  syncConfigFromDb,
  maskKey,
  isOwner
};
