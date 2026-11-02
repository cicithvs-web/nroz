/**
 * bot/workspace.js — Folder workspace per sesi dan auto-cleanup file lama.
 */

const fs = require("fs");
const path = require("path");
const { WORKSPACE_BASE, sessionWorkspacePath } = require("../lib/paths");

/**
 * Folder yang TIDAK PERNAH dihapus auto-cleanup, berapa pun umurnya:
 *   .memory  memori AI (decisions.md, project_context.md, arsip chat, checkpoint)
 *   skills   keahlian hasil belajar (/learn, save_skill)
 *   work     proyek yang sedang dikerjakan
 *   uploads  file asli kiriman user (supaya bisa diolah lagi tanpa kirim ulang)
 * mtime folder hanya berubah kalau isi langsungnya berubah, jadi folder yang masih dipakai
 * pun bisa terlihat "tua". /clean (perintah manual user) tetap menghapus semuanya.
 */
const PROTECTED_ENTRIES = new Set([".memory", "skills", "work", "uploads"]);

function getChatWorkspace(sessionId) {
  const dir = sessionWorkspacePath(sessionId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Ukuran total file di dalam path (tanpa mengikuti symlink). */
function diskUsage(p) {
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const name of fs.readdirSync(p)) total += diskUsage(path.join(p, name));
    return total;
  } catch (_) {
    return 0;
  }
}

/**
 * Menghapus item level atas di workspace tiap sesi yang berusia > maxAgeDays,
 * kecuali PROTECTED_ENTRIES.
 * @returns {{ deletedCount: number, freedBytes: number, deleted: string[] }}
 */
function cleanupOldWorkspaceFiles(maxAgeDays = 3, { base = WORKSPACE_BASE, now = Date.now() } = {}) {
  const result = { deletedCount: 0, freedBytes: 0, deleted: [] };
  if (!fs.existsSync(base)) return result;

  const MAX_AGE_MS = maxAgeDays * 24 * 60 * 60 * 1000;

  try {
    for (const userDir of fs.readdirSync(base)) {
      const userDirPath = path.join(base, userDir);
      try {
        const userDirStat = fs.lstatSync(userDirPath);
        if (!userDirStat.isDirectory()) continue;

        for (const item of fs.readdirSync(userDirPath)) {
          if (PROTECTED_ENTRIES.has(item)) continue;
          const itemPath = path.join(userDirPath, item);
          try {
            const itemStat = fs.lstatSync(itemPath);
            if (now - itemStat.mtimeMs > MAX_AGE_MS) {
              result.freedBytes += diskUsage(itemPath);
              fs.rmSync(itemPath, { recursive: true, force: true });
              result.deletedCount++;
              result.deleted.push(path.join(userDir, item));
            }
          } catch (_) {}
        }

        // Hapus folder user jika kosong dan sudah berumur > maxAgeDays
        if (fs.readdirSync(userDirPath).length === 0 && now - userDirStat.mtimeMs > MAX_AGE_MS) {
          try {
            fs.rmdirSync(userDirPath);
          } catch (_) {}
        }
      } catch (_) {}
    }

    if (result.deletedCount > 0) {
      const freedMb = (result.freedBytes / (1024 * 1024)).toFixed(2);
      console.log(
        `[Auto-Cleanup] Menghapus ${result.deletedCount} item lama (> ${maxAgeDays} hari, ${freedMb} MB): ${result.deleted.join(", ")}`
      );
    }
  } catch (err) {
    console.warn("[Auto-Cleanup] Error saat menjalankan pembersihan:", err.message);
  }

  return result;
}

/** Jalankan saat startup lalu tiap 6 jam. */
function startAutoCleanup(maxAgeDays = 3) {
  if (!fs.existsSync(WORKSPACE_BASE)) fs.mkdirSync(WORKSPACE_BASE, { recursive: true });
  cleanupOldWorkspaceFiles(maxAgeDays);
  return setInterval(() => cleanupOldWorkspaceFiles(maxAgeDays), 6 * 60 * 60 * 1000);
}

module.exports = { PROTECTED_ENTRIES, getChatWorkspace, cleanupOldWorkspaceFiles, startAutoCleanup };
