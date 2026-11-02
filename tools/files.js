/**
 * tools/files.js — Tool file di host: file_read, file_write, file_edit, file_list, send_photo, send_file.
 *
 * Semua path dikunci ke workspace sesi lewat resolveFilePath (lib/pathGuard.js):
 * path absolut di luar /workspace dan symlink yang keluar dari workspace ditolak.
 */

const fs = require("fs");
const path = require("path");
const { getSessionWorkspace } = require("../sandboxManager.js");
const { truncate, toSandboxPath, resolveFilePath, isSensitiveFile } = require("./common");

/**
 * Tool: file_read
 */
async function toolFileRead({ path: filePath, sessionId }) {
  if (!filePath || typeof filePath !== "string") {
    return "❌ Parameter 'path' wajib berupa string.";
  }

  const guard = resolveFilePath(filePath, sessionId);
  if (!guard.ok) return `⛔ ${guard.error}`;
  const resolved = guard.path;

  if (isSensitiveFile(resolved)) {
    return `⛔ Akses ditolak: file '${filePath}' termasuk file sensitif yang diproteksi.`;
  }

  try {
    if (!fs.existsSync(resolved)) {
      return `❌ File tidak ditemukan: ${toSandboxPath(resolved, sessionId)}`;
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return `❌ Path '${filePath}' adalah direktori, bukan file. Gunakan tool file_list.`;
    }

    if (stat.size > 5 * 1024 * 1024) {
      return `⚠️ File terlalu besar (${(stat.size / 1024 / 1024).toFixed(2)} MB). Maksimum 5 MB.`;
    }

    const content = fs.readFileSync(resolved, "utf-8");
    return truncate(`📄 ${toSandboxPath(resolved, sessionId)} (${stat.size} bytes):\n\n${content}`);
  } catch (err) {
    return `❌ Gagal membaca file: ${err.message}`;
  }
}

/**
 * Tool: file_write
 */
async function toolFileWrite({ path: filePath, content, sessionId }) {
  if (!filePath || typeof filePath !== "string") {
    return "❌ Parameter 'path' wajib berupa string.";
  }
  if (content === undefined || content === null) {
    return "❌ Parameter 'content' wajib diisi.";
  }

  const guard = resolveFilePath(filePath, sessionId);
  if (!guard.ok) return `⛔ ${guard.error}`;
  const resolved = guard.path;

  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, String(content), "utf-8");
    const size = Buffer.byteLength(String(content), "utf-8");
    return `✅ Berhasil menulis ${toSandboxPath(resolved, sessionId)} (${size} bytes)`;
  } catch (err) {
    return `❌ Gagal menulis file: ${err.message}`;
  }
}

/**
 * Tool: file_edit
 * Mengganti blok teks 'target' dengan 'replacement' tanpa menyentuh sisa file.
 */
async function toolFileEdit({ path: filePath, target, replacement, sessionId }) {
  if (!filePath || typeof filePath !== "string") {
    return "❌ Parameter 'path' wajib berupa string.";
  }
  if (typeof target !== "string" || target.length === 0) {
    return "❌ Parameter 'target' wajib berupa string teks yang ingin diganti (tidak boleh kosong).";
  }
  if (typeof replacement !== "string") {
    return "❌ Parameter 'replacement' wajib berupa string (gunakan string kosong \"\" jika ingin menghapus target).";
  }

  const guard = resolveFilePath(filePath, sessionId);
  if (!guard.ok) return `⛔ ${guard.error}`;
  const resolved = guard.path;

  if (!fs.existsSync(resolved)) {
    return `❌ File '${filePath}' tidak ditemukan. Gunakan tool 'file_write' jika ingin membuat file baru dari nol.`;
  }

  try {
    const content = fs.readFileSync(resolved, "utf-8");

    // Tangani normalisasi line-ending jika file menggunakan CRLF vs LF
    let effectiveTarget = target;
    if (!content.includes(effectiveTarget)) {
      if (content.includes(target.replace(/\r\n/g, "\n"))) {
        effectiveTarget = target.replace(/\r\n/g, "\n");
      } else if (content.includes(target.replace(/\n/g, "\r\n"))) {
        effectiveTarget = target.replace(/\n/g, "\r\n");
      }
    }

    if (!content.includes(effectiveTarget)) {
      return (
        `❌ Target teks tidak ditemukan dalam file '${filePath}'.\n` +
        `Tips: Pastikan teks 'target' sama persis karakter per karakter termasuk spasi dan indentasi. ` +
        `Gunakan tool 'file_read' terlebih dahulu untuk melihat isi file yang sebenarnya.`
      );
    }

    const occurrences = content.split(effectiveTarget).length - 1;
    const newContent = content.replaceAll(effectiveTarget, replacement);
    fs.writeFileSync(resolved, newContent, "utf-8");

    const diffLines = replacement.split("\n").length - effectiveTarget.split("\n").length;
    const diffStr = diffLines >= 0 ? `+${diffLines}` : `${diffLines}`;

    return (
      `✅ Berhasil mengedit file '${filePath}' (${occurrences} bagian diganti, ${diffStr} baris).\n` +
      `Dari sandbox terlihat sebagai: ${toSandboxPath(resolved, sessionId)}`
    );
  } catch (err) {
    return `❌ Gagal mengedit file: ${err.message}`;
  }
}

/**
 * Tool: file_list
 */
async function toolFileList({ path: dirPath, sessionId }) {
  const guard = resolveFilePath(dirPath || "/workspace", sessionId);
  if (!guard.ok) return `⛔ ${guard.error}`;
  const resolved = guard.path;
  const shown = toSandboxPath(resolved, sessionId);

  try {
    if (!fs.existsSync(resolved)) {
      return `❌ Direktori tidak ditemukan: ${shown}`;
    }
    if (!fs.statSync(resolved).isDirectory()) {
      return `❌ Path '${shown}' bukan direktori. Gunakan tool file_read untuk membaca file.`;
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    if (entries.length === 0) {
      return `📁 ${shown}: (direktori kosong)`;
    }

    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const lines = sorted.map((entry) => {
      const icon = entry.isDirectory() ? "📁" : entry.isSymbolicLink() ? "🔗" : "📄";
      let sizeStr = "";
      if (entry.isFile()) {
        try {
          const kb = fs.statSync(path.join(resolved, entry.name)).size / 1024;
          sizeStr = kb >= 1024 ? ` (${(kb / 1024).toFixed(1)} MB)` : ` (${kb.toFixed(1)} KB)`;
        } catch (_) {}
      }
      return `  ${icon} ${entry.name}${sizeStr}`;
    });

    return truncate(`📁 ${shown} (${entries.length} item):\n\n${lines.join("\n")}`);
  } catch (err) {
    return `❌ Gagal membaca direktori: ${err.message}`;
  }
}

/**
 * Mencari file kiriman di workspace dengan toleransi folder artifacts/ dan root workspace.
 * Hanya kandidat yang lolos pathGuard yang dipakai.
 * @returns {{ path: string|null, error?: string }}
 */
function findWorkspaceFile(rawPath, sessionId) {
  const primary = resolveFilePath(rawPath, sessionId);
  const base = path.basename(String(rawPath || ""));
  const candidates = [];
  if (primary.ok) candidates.push(primary.path);
  if (base) {
    candidates.push(path.join(getSessionWorkspace(sessionId), "artifacts", base));
    candidates.push(path.join(getSessionWorkspace(sessionId), base));
  }

  for (const c of candidates) {
    const g = resolveFilePath(c, sessionId);
    if (!g.ok) continue;
    try {
      if (fs.statSync(g.path).isFile()) return { path: g.path };
    } catch (_) {}
  }
  return { path: null, error: primary.ok ? null : primary.error };
}

/**
 * Tool: send_photo
 */
async function toolSendPhoto({ file_path, caption, sessionId, chatId, threadId, bot, onMediaSent }) {
  if (!file_path) return "❌ Parameter 'file_path' wajib diisi.";
  const found = findWorkspaceFile(file_path, sessionId);
  if (!found.path) {
    if (found.error) return `⛔ ${found.error}`;
    return `❌ File gambar tidak ditemukan di: ${file_path}. Pastikan file gambar sudah dibuat sebelumnya di /workspace/ atau /workspace/artifacts/.`;
  }
  const hostPath = found.path;
  const fileName = path.basename(hostPath);

  if (!bot || !chatId) {
    return `✅ Gambar '${fileName}' siap dikirim. <<<SENDPHOTO:${file_path}>>>`;
  }

  const sendOpts = {};
  if (caption) {
    sendOpts.caption = caption;
    sendOpts.parse_mode = "Markdown";
  }
  if (threadId) sendOpts.message_thread_id = threadId;

  try {
    await bot.sendPhoto(chatId, hostPath, sendOpts);
    if (typeof onMediaSent === "function") onMediaSent("photo");
    return `✅ Foto '${fileName}' berhasil dikirim langsung ke chat Telegram user.`;
  } catch (err) {
    console.error(`[toolSendPhoto Error] ${err.message}`);
    try {
      const docOpts = { caption: caption || `🖼️ Gambar: ${fileName}` };
      if (threadId) docOpts.message_thread_id = threadId;
      await bot.sendDocument(chatId, hostPath, docOpts);
      if (typeof onMediaSent === "function") onMediaSent("photo");
      return `✅ Gambar '${fileName}' berhasil dikirim sebagai dokumen ke chat Telegram user.`;
    } catch (docErr) {
      return `❌ Gagal mengirim foto ke Telegram: ${err.message}`;
    }
  }
}

/**
 * Tool: send_file
 */
async function toolSendFile({ file_path, caption, sessionId, chatId, threadId, bot, onMediaSent }) {
  if (!file_path) return "❌ Parameter 'file_path' wajib diisi.";
  const found = findWorkspaceFile(file_path, sessionId);
  if (!found.path) {
    if (found.error) return `⛔ ${found.error}`;
    return `❌ File tidak ditemukan di: ${file_path}.`;
  }
  const hostPath = found.path;
  const fileName = path.basename(hostPath);

  if (!bot || !chatId) {
    return `✅ File '${fileName}' siap dikirim. <<<SENDFILE:${file_path}>>>`;
  }

  const sendOpts = {};
  if (caption) sendOpts.caption = caption;
  if (threadId) sendOpts.message_thread_id = threadId;

  try {
    try {
      await bot.sendDocument(chatId, hostPath, caption ? { ...sendOpts, parse_mode: "Markdown" } : sendOpts);
    } catch (err) {
      if (!/can't parse entities/i.test(err.message)) throw err;
      await bot.sendDocument(chatId, hostPath, sendOpts);
    }
    if (typeof onMediaSent === "function") onMediaSent("file");
    return `✅ File '${fileName}' berhasil dikirim langsung ke chat Telegram user.`;
  } catch (err) {
    console.error(`[toolSendFile Error] ${err.message}`);
    return `❌ Gagal mengirim file ke Telegram: ${err.message}`;
  }
}

module.exports = {
  toolFileRead,
  toolFileWrite,
  toolFileEdit,
  toolFileList,
  toolSendPhoto,
  toolSendFile,
  findWorkspaceFile
};
