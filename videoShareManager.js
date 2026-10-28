/**
 * videoShareManager.js — Link unduhan untuk hasil render yang terlalu besar untuk Bot API
 *
 * Bot Telegram hanya boleh meng-upload 50 MB per file, jadi video panjang dikirim sebagai
 * link HTTPS lewat Cloudflare Quick Tunnel. File disajikan dari server HTTP lokal yang
 * HANYA menempel di 127.0.0.1 dan hanya bisa diakses lewat token acak — tidak ada daftar
 * isi folder, tidak ada path yang dibaca dari URL.
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { startWebPreview } = require("./webPreviewManager.js");

const SHARE_PORT = Number(process.env.VIDEO_SHARE_PORT) || 4789;
const TTL_HOURS = Number(process.env.VIDEO_SHARE_TTL_HOURS) || 72;
const TTL_MS = TTL_HOURS * 3600_000;

/** token -> { filePath, sizeBytes, chatId, createdAt, expiresAt } */
const shares = new Map();
let server = null;

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".zip") return "application/zip";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

function deny(res, code, message) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

function serve(req, res) {
  // Bentuk URL: /d/<token>/<nama-file> — nama file cuma untuk tampilan, path asli selalu
  // diambil dari record token, jadi tidak ada celah path traversal sama sekali.
  let parts;
  try {
    parts = decodeURIComponent(req.url.split("?")[0]).split("/").filter(Boolean);
  } catch (_) {
    return deny(res, 400, "URL tidak valid.");
  }
  if (parts[0] !== "d" || !/^[0-9a-f]{32}$/.test(parts[1] || "")) {
    return deny(res, 404, "Tautan tidak dikenal.");
  }

  const rec = shares.get(parts[1]);
  if (!rec) return deny(res, 404, "Tautan tidak dikenal.");
  if (rec.expiresAt < Date.now()) {
    shares.delete(parts[1]);
    return deny(res, 410, "Tautan ini sudah kedaluwarsa.");
  }
  if (!fs.existsSync(rec.filePath)) {
    shares.delete(parts[1]);
    return deny(res, 410, "File sudah dibersihkan dari server.");
  }

  const total = rec.sizeBytes;
  const head = {
    "Content-Type": contentTypeFor(rec.filePath),
    "Content-Disposition": `inline; filename="${path.basename(rec.filePath).replace(/"/g, "")}"`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=0, no-store"
  };

  let status = 200;
  let start = 0;
  let end = total - 1;
  const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (rangeMatch) {
    const [, rawStart, rawEnd] = rangeMatch;
    if (rawStart === "" && rawEnd === "") return deny(res, 416, "Range tidak valid.");
    start = rawStart === "" ? Math.max(0, total - Number(rawEnd)) : Number(rawStart);
    end = rawStart === "" || rawEnd === "" ? total - 1 : Math.min(Number(rawEnd), total - 1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      return res.end("Range tidak valid.");
    }
    status = 206;
    head["Content-Range"] = `bytes ${start}-${end}/${total}`;
  }

  head["Content-Length"] = end - start + 1;
  if (req.method === "HEAD") {
    res.writeHead(status, head);
    return res.end();
  }

  const stream = fs.createReadStream(rec.filePath, { start, end });
  stream.on("error", () => deny(res, 500, "Gagal membaca file."));
  res.writeHead(status, head);
  stream.pipe(res);
}

function ensureServer() {
  if (server) return server;
  server = http.createServer(serve);
  server.listen(SHARE_PORT, "127.0.0.1", () => {
    console.log(`[Video Share] Server link unduhan aktif di 127.0.0.1:${SHARE_PORT}`);
  });

  const prune = setInterval(() => {
    const now = Date.now();
    for (const [token, rec] of shares) {
      if (rec.expiresAt < now) shares.delete(token);
    }
  }, 30 * 60_000);
  prune.unref();

  return server;
}

/**
 * Cloudflare memberi hostname baru untuk setiap quick tunnel, dan DNS-nya baru bisa
 * dijawab setelah ±1 menit. Tanpa probe ini, user yang langsung menyentuh link dikirim
 * bot akan melihat "domain not found".
 */
function waitForDns(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const probe = () => {
      const req = https.get(url, { timeout: 4000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => {
        if (Date.now() < deadline) setTimeout(probe, 4000);
        else resolve(false);
      });
    };
    probe();
  });
}

/**
 * Buat link publik untuk satu file. Tunnel CF dibuat sekali dan dipakai ulang.
 * @returns {Promise<{url: string, expiresAt: number, sizeMb: string, ready: boolean}>}
 */
async function createShareLink(filePath, meta = {}) {
  ensureServer();
  if (!fs.existsSync(filePath)) throw new Error(`File tidak ditemukan: ${filePath}`);

  const tunnelUrl = await startWebPreview(SHARE_PORT, Math.ceil(TTL_MS / 60_000) + 30);
  const token = crypto.randomBytes(16).toString("hex");
  const stat = fs.statSync(filePath);

  shares.set(token, {
    filePath,
    sizeBytes: stat.size,
    chatId: meta.chatId ?? null,
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS
  });

  const url = `${tunnelUrl}/d/${token}/${encodeURIComponent(path.basename(filePath))}`;
  const ready = await waitForDns(url);
  if (!ready) console.warn(`[Video Share] DNS link belum terjawab setelah 90 detik: ${url}`);

  return {
    url,
    token,
    ready,
    sizeMb: (stat.size / (1024 * 1024)).toFixed(1),
    expiresAt: Date.now() + TTL_MS
  };
}

function listShares() {
  const now = Date.now();
  return [...shares.values()]
    .filter((rec) => rec.expiresAt > now)
    .map((rec) => ({ file: path.basename(rec.filePath), sizeMb: (rec.sizeBytes / (1024 * 1024)).toFixed(1), expiresAt: rec.expiresAt }));
}

module.exports = { createShareLink, listShares, SHARE_PORT, TTL_HOURS };
