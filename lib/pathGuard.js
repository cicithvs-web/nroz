/**
 * lib/pathGuard.js — Mengunci akses file host ke folder workspace sesi.
 *
 * Tool file_* dan pengiriman file berjalan di HOST, bukan di sandbox. Tanpa penjaga ini,
 * path absolut seperti /root/nroz/.env atau /root/.ssh/authorized_keys bisa dibaca/ditulis.
 * Sandbox berjalan sebagai root dan bisa membuat symlink di /workspace yang menunjuk ke
 * path host, jadi pemeriksaan juga memakai realpath, bukan hanya teks path.
 */

const fs = require("fs");
const path = require("path");
const { sessionWorkspacePath } = require("./paths");

/** true kalau `child` sama dengan atau berada di dalam `parent`. */
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * realpath untuk path yang mungkin belum ada: bagian yang sudah ada di-resolve
 * (symlink diikuti), sisa segmen yang belum ada ditempel di belakangnya.
 */
function realpathOfExistingPrefix(p) {
  let current = p;
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
      const parent = path.dirname(current);
      if (parent === current) return p;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Menerjemahkan path dari model/user ke path host di dalam workspace sesi.
 *   /workspace/x            -> <workspace sesi>/x
 *   x atau ./x              -> <workspace sesi>/x
 *   /root/nroz/workspace/<sesi>/x -> diterima kalau memang milik sesi ini
 *   path absolut lain       -> ditolak
 *
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
function resolveInWorkspace(rawPath, sessionId, { base } = {}) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { ok: false, error: "Path kosong atau bukan string." };
  }
  const ws = path.resolve(sessionWorkspacePath(sessionId, base));
  const p = rawPath.trim();

  let candidate;
  if (p === "/workspace" || p.startsWith("/workspace/")) {
    candidate = path.resolve(ws, "." + p.slice("/workspace".length));
  } else if (path.isAbsolute(p)) {
    candidate = path.resolve(p);
  } else {
    candidate = path.resolve(ws, p);
  }

  if (!isInside(candidate, ws)) {
    return {
      ok: false,
      error:
        `Akses ditolak: '${rawPath}' berada di luar workspace. ` +
        `Tool file hanya boleh memakai /workspace/... (folder kerja sesi ini).`
    };
  }

  let realWs;
  try {
    realWs = fs.existsSync(ws) ? fs.realpathSync(ws) : ws;
    const real = realpathOfExistingPrefix(candidate);
    if (!isInside(real, realWs)) {
      return {
        ok: false,
        error: `Akses ditolak: '${rawPath}' adalah symlink yang menunjuk ke luar workspace.`
      };
    }
  } catch (err) {
    return { ok: false, error: `Path '${rawPath}' tidak bisa diperiksa: ${err.message}` };
  }

  return { ok: true, path: candidate };
}

/** Versi singkat: path host atau null kalau ditolak. */
function workspacePathOrNull(rawPath, sessionId, opts) {
  const res = resolveInWorkspace(rawPath, sessionId, opts);
  return res.ok ? res.path : null;
}

/** File biasa (bukan symlink/direktori) yang aman di dalam workspace sesi. */
function isSafeWorkspaceFile(hostPath, sessionId, opts) {
  const res = resolveInWorkspace(hostPath, sessionId, opts);
  if (!res.ok) return false;
  try {
    return fs.statSync(res.path).isFile();
  } catch {
    return false;
  }
}

module.exports = {
  isInside,
  realpathOfExistingPrefix,
  resolveInWorkspace,
  workspacePathOrNull,
  isSafeWorkspaceFile
};
