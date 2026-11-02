/**
 * tools/common.js — Utilitas bersama untuk semua tool agent.
 */

const fs = require("fs");
const path = require("path");
const { getSessionWorkspace } = require("../sandboxManager.js");
const { WORKSPACE_BASE } = require("../lib/paths");
const { resolveInWorkspace } = require("../lib/pathGuard");

/** Batas maksimum karakter output yang dikembalikan ke model */
const MAX_OUTPUT = 4000;

/**
 * Memotong teks jika melebihi batas karakter dan memberi tahu bahwa output terpotong.
 */
function truncate(text, limit = MAX_OUTPUT) {
  if (typeof text !== "string") text = String(text);
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n\n... [Output terpotong, total " + text.length + " karakter]";
}

/**
 * Model sering mencampur path host (/root/nroz/workspace/<id>) dengan path sandbox
 * (/workspace). Path sandbox diterjemahkan ke host di sini; validasi batas workspace
 * dilakukan oleh resolveFilePath.
 */
const toHostPath = (p, sessionId) => {
  if (typeof p !== "string" || !p) return p;
  if (p === "/workspace" || p.startsWith("/workspace/")) {
    return path.join(getSessionWorkspace(sessionId), p.slice("/workspace".length));
  }
  return p;
};

const toSandboxPath = (text, sessionId) => {
  if (typeof text !== "string") return text;
  const hostWs = getSessionWorkspace(sessionId);
  let out = text.includes(hostWs) ? text.split(hostWs).join("/workspace") : text;
  // Container cuma melihat satu folder workspace, jadi path session lain juga dipetakan ke /workspace
  out = out.replace(new RegExp(`${WORKSPACE_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[A-Za-z0-9_\\-]+`, "g"), "/workspace");
  return out;
};

/**
 * Menerjemahkan path dari model ke path host yang DIJAMIN berada di workspace sesi.
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
function resolveFilePath(filePath, sessionId) {
  return resolveInWorkspace(filePath, sessionId);
}

/**
 * Pola nama file sensitif yang tetap tidak dibaca walau ada di dalam workspace.
 */
const BLOCKED_READ_PATHS = [
  /\.env$/i,
  /\.env\./i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.pem$/i,
  /\.key$/i,
  /private.*key/i,
];

function isSensitiveFile(p) {
  const resolved = path.resolve(p);
  return BLOCKED_READ_PATHS.some((re) => re.test(resolved));
}

/** Ambil exit code dari error child_process (execFile menaruh angka di err.code). */
function exitCodeOf(err) {
  const code = typeof err.code === "number" ? err.code : err.status;
  return typeof code === "number" ? String(code) : "?";
}

/** Potongan pendek perintah untuk registry job (bukan untuk dieksekusi). */
function toHostPathPreview(command) {
  const oneLine = String(command).replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}

/** Ambil bagian akhir file tanpa membaca seluruhnya (log job background bisa besar). */
function tailFile(file, maxBytes = 8192) {
  try {
    const stat = fs.statSync(file);
    const len = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, len, Math.max(0, stat.size - len));
    fs.closeSync(fd);
    return buf.toString("utf-8");
  } catch (_) {
    return "";
  }
}

module.exports = {
  MAX_OUTPUT,
  truncate,
  toHostPath,
  toSandboxPath,
  resolveFilePath,
  isSensitiveFile,
  exitCodeOf,
  toHostPathPreview,
  tailFile
};
