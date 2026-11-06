/**
 * webhookManager.js — Webhook masuk: event dari layanan eksternal → notif chat / agent berjalan.
 *
 * Server HTTP kecil HANYA menempel di 127.0.0.1. URL publik dibuka lewat Cloudflare Quick
 * Tunnel (perintah owner /webhookurl). Tiap hook punya token acak 32-hex sebagai path,
 * jadi tidak ada daftar isi dan tidak ada path dari URL.
 *
 * Format panggilan: POST /h/<token>  (body JSON atau teks mentah, maks 64 KB)
 * Mode hook:
 *   - "notify": payload diteruskan ke chat sebagai pesan.
 *   - "agent" : payload dibungkus jadi prompt dan membangunkan agent loop (bot/agentTrigger.js).
 */

const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { writeJsonAtomic, readJsonSafe } = require("./lib/atomicFile");
const { startWebPreview } = require("./webPreviewManager.js");

const DATA_FILE = path.join(__dirname, "webhook_data.json");
const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT) || 4790;
const MAX_BODY_BYTES = 64 * 1024;
const MIN_FIRE_INTERVAL_MS = 500;
const EVENT_TEXT_LIMIT = 3500;
const MODES = ["notify", "agent"];
const TUNNEL_HOURS = Number(process.env.WEBHOOK_TUNNEL_HOURS) || 720;

let hooks = [];
let server = null;
let botInstance = null;
let tunnelUrl = null;

// ============================================================
// HELPER MURNI (diuji di test/webhook.test.js)
// ============================================================

/** Nama hook: 3-32 karakter huruf kecil, angka, dash, underscore. */
function sanitizeHookName(raw) {
  const name = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (name.length < 3 || name.length > 32) {
    throw new Error("Nama hook harus 3-32 karakter (huruf kecil, angka, -, _).");
  }
  return name;
}

/** "/h/<token>" atau "/hook/<token>" -> token | null. Token hanya 32 hex. */
function parseHookPath(urlPath) {
  const clean = String(urlPath || "").split("?")[0];
  const m = clean.match(/^\/h(?:ook)?\/([0-9a-f]{32})\/?$/);
  return m ? m[1] : null;
}

/** Teks event yang dikirim ke chat / dipakai sebagai prompt agent. */
function truncateEventText(bodyText) {
  const text = String(bodyText || "").trim();
  return text.length > EVENT_TEXT_LIMIT ? text.slice(0, EVENT_TEXT_LIMIT) + "\n…(dipotong)" : text;
}

function buildNotifyText(hook, bodyText) {
  return `🔗 *Webhook: ${hook.name}*\n\n${truncateEventText(bodyText) || "(payload kosong)"}`;
}

function buildAgentPrompt(hook, bodyText) {
  return (
    `🔗 [EVENT WEBHOOK: ${hook.name}]\n\n` +
    `Payload dari layanan eksternal berikut baru saja masuk. Tinjau isinya, lalu ambil tindakan yang ` +
    `paling masuk akal untuk user (misal: merangkum, mengecek sesuatu, atau memberi tahu apa yang perlu ` +
    `dilakukan). Kalau payload tidak meminta apa pun, cukup laporkan ringkasannya.\n\n` +
    `--- PAYLOAD ---\n${truncateEventText(bodyText) || "(payload kosong)"}`
  );
}

// ============================================================
// PERSISTENSI
// ============================================================

function loadData() {
  const data = readJsonSafe(DATA_FILE, { hooks: [] });
  hooks = (data.hooks || []).filter((h) => h && h.token && h.name);
}

function saveData() {
  try {
    writeJsonAtomic(DATA_FILE, { hooks });
  } catch (err) {
    console.warn("[Webhook] Gagal menyimpan webhook_data.json:", err.message);
  }
}

loadData();

// ============================================================
// SERVER
// ============================================================

function findHookByToken(token) {
  return hooks.find((h) => h.token === token) || null;
}

async function deliver(hook, bodyText) {
  const now = Date.now();
  if (hook.lastFiredAt && now - hook.lastFiredAt < MIN_FIRE_INTERVAL_MS) return { ok: false, code: 429, reason: "too fast" };
  hook.lastFiredAt = now;
  hook.fireCount = (hook.fireCount || 0) + 1;
  saveData();

  if (hook.mode === "agent") {
    const { runAgentTask } = require("./bot/agentTrigger.js");
    const res = await runAgentTask({
      sessionId: hook.sessionId,
      chatId: hook.chatId,
      threadId: hook.threadId,
      sourceLabel: `Webhook: ${hook.name}`,
      prompt: buildAgentPrompt(hook, bodyText),
      notify: false
    });
    if (!res.started) console.warn(`[Webhook] Agent tidak jalan untuk hook '${hook.name}': ${res.reason}`);
    return { ok: res.started, code: res.started ? 200 : 202, reason: res.reason || "" };
  }

  // mode notify
  const text = buildNotifyText(hook, bodyText);
  const opts = hook.threadId ? { message_thread_id: hook.threadId } : {};
  try {
    await botInstance.sendMessage(hook.chatId, text, { parse_mode: "Markdown", ...opts });
  } catch (err) {
    if (!/can't parse entities/i.test(err.message)) throw err;
    await botInstance.sendMessage(hook.chatId, text.replace(/[*_`]/g, ""), opts);
  }
  return { ok: true, code: 200, reason: "" };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Payload terlalu besar (maks 64 KB)"), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function json(res, code, message) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: code < 400, message }));
}

async function handleRequest(req, res) {
  const token = parseHookPath(req.url);
  if (!token) return json(res, 404, "Endpoint hook tidak dikenal.");

  const hook = findHookByToken(token);
  if (!hook) return json(res, 404, "Hook tidak ditemukan atau sudah dihapus.");

  let bodyText = "";
  try {
    bodyText = await readBody(req);
  } catch (err) {
    return json(res, err.code || 400, err.message);
  }
  if (req.method === "GET") bodyText = bodyText || `ping dari ${req.socket.remoteAddress || "client"}`;
  else if (req.method !== "POST") return json(res, 405, "Gunakan POST (atau GET untuk ping).");

  // JSON dipertahankan apa adanya (teks terformat) supaya agent bisa membaca strukturnya.
  try {
    const parsed = JSON.parse(bodyText);
    bodyText = JSON.stringify(parsed, null, 2);
  } catch (_) { /* bukan JSON — pakai teks mentah */ }

  try {
    const result = await deliver(hook, bodyText);
    if (result.ok) return json(res, 200, "Event diterima.");
    return json(res, result.code, `Event tidak diproses: ${result.reason}`);
  } catch (err) {
    console.error(`[Webhook] Gagal mengirim event hook '${hook.name}':`, err.message);
    return json(res, 502, "Gagal mengirim event ke Telegram.");
  }
}

function initWebhooks(bot) {
  botInstance = bot;
  if (server) return server;
  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("[Webhook] Error handler:", err.message);
      try { json(res, 500, "Internal error."); } catch (_) {}
    });
  });
  server.listen(WEBHOOK_PORT, "127.0.0.1", () => {
    console.log(`[Webhook] Server hook aktif di 127.0.0.1:${WEBHOOK_PORT} (${hooks.length} hook terdaftar).`);
  });
  return server;
}

// ============================================================
// API (dipakai perintah owner di bot/commands.js)
// ============================================================

function addHook({ name, mode = "notify", sessionId, chatId, threadId = null }) {
  const cleanName = sanitizeHookName(name);
  if (!MODES.includes(mode)) throw new Error(`Mode harus salah satu dari: ${MODES.join(", ")}`);
  if (hooks.some((h) => h.name === cleanName)) throw new Error(`Hook '${cleanName}' sudah ada. Hapus dulu dengan /delhook ${cleanName}`);

  const hook = {
    name: cleanName,
    token: crypto.randomBytes(16).toString("hex"),
    mode,
    sessionId: String(sessionId ?? chatId),
    chatId: String(chatId),
    threadId: threadId ?? null,
    createdAt: Date.now(),
    lastFiredAt: 0,
    fireCount: 0
  };
  hooks.push(hook);
  saveData();
  return hook;
}

function removeHook(name) {
  const cleanName = String(name || "").trim().toLowerCase();
  const before = hooks.length;
  hooks = hooks.filter((h) => h.name !== cleanName);
  const removed = before !== hooks.length;
  if (removed) saveData();
  return removed;
}

function listHooks() {
  return hooks.map((h) => ({
    name: h.name,
    mode: h.mode,
    chatId: h.chatId,
    threadId: h.threadId,
    fireCount: h.fireCount || 0,
    lastFiredAt: h.lastFiredAt || null,
    createdAt: h.createdAt
  }));
}

function getHookToken(name) {
  const cleanName = String(name || "").trim().toLowerCase();
  return hooks.find((h) => h.name === cleanName)?.token || null;
}

/** URL lengkap satu hook berdasarkan nama, mis. https://xyz.trycloudflare.com/h/<token>. */
function hookUrlByName(name, baseUrl) {
  const token = getHookToken(name);
  if (!token) return null;
  const base = baseUrl || tunnelUrl || `http://127.0.0.1:${WEBHOOK_PORT}`;
  return `${base.replace(/\/+$/, "")}/h/${token}`;
}

/**
 * Buka URL publik untuk semua hook (Cloudflare Quick Tunnel). Hostname berubah tiap
 * restart bot — panggil ulang perintah /webhookurl setelah restart.
 */
async function ensureTunnel() {
  if (tunnelUrl) return tunnelUrl;
  tunnelUrl = await startWebPreview(WEBHOOK_PORT, Math.ceil(TUNNEL_HOURS * 60), { allowHost: true });
  return tunnelUrl;
}

function fullHookUrl(hook, baseUrl) {
  const base = baseUrl || tunnelUrl || `http://127.0.0.1:${WEBHOOK_PORT}`;
  return `${base.replace(/\/+$/, "")}/h/${hook.token}`;
}

module.exports = {
  initWebhooks,
  addHook,
  removeHook,
  listHooks,
  getHookToken,
  hookUrlByName,
  ensureTunnel,
  fullHookUrl,
  WEBHOOK_PORT,
  MODES,
  // helper murni untuk unit test
  sanitizeHookName,
  parseHookPath,
  truncateEventText,
  buildNotifyText,
  buildAgentPrompt,
  _reloadForTests: loadData
};
