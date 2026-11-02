/**
 * lib/paths.js — Lokasi folder proyek yang dipakai bersama oleh bot dan tool.
 */

const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const WORKSPACE_BASE = path.join(ROOT_DIR, "workspace");

/** Nama folder sesi yang aman: hanya huruf, angka, garis bawah, dan strip. */
function safeSessionId(sessionId) {
  return String(sessionId || "default").trim().replace(/[^a-zA-Z0-9_\-]/g, "_");
}

/** Path folder workspace sesi di host (tanpa membuat foldernya). */
function sessionWorkspacePath(sessionId, base = WORKSPACE_BASE) {
  return path.join(base, safeSessionId(sessionId));
}

module.exports = { ROOT_DIR, WORKSPACE_BASE, safeSessionId, sessionWorkspacePath };
