/**
 * tools/files.js — Tool file di host: file_read, file_write, file_edit, file_list, send_photo, send_file.
 *
 * Semua path dikunci ke workspace sesi lewat resolveFilePath (lib/pathGuard.js):
 * path absolut di luar /workspace dan symlink yang keluar dari workspace ditolak.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { getSessionWorkspace } = require("../sandboxManager.js");
const { truncate, toSandboxPath, resolveFilePath, isSensitiveFile } = require("./common");

/**
 * Instant Syntax Linter otomatis setelah file_write atau file_edit.
 * Mengembalikan string kosong jika valid, atau pesan peringatan baris error jika ada kesalahan sintaks.
 */
function checkFileSyntax(resolvedPath, content) {
  const ext = path.extname(resolvedPath).toLowerCase();
  if (!ext) return "";

  if (ext === ".json") {
    try {
      JSON.parse(content);
      return "";
    } catch (err) {
      return `\n⚠️ [Peringatan Sintaks JSON — segera perbaiki dengan file_edit]: ${err.message}`;
    }
  }

  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") {
    try {
      execFileSync(process.execPath, ["--check", resolvedPath], {
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"]
      });
      return "";
    } catch (err) {
      const stderr = (err.stderr ? err.stderr.toString() : err.message || "").trim();
      const shortErr = stderr.split("\n").slice(0, 5).join("\n");
      return `\n⚠️ [Peringatan Sintaks JS — segera perbaiki dengan file_edit]:\n${shortErr}`;
    }
  }

  if (ext === ".sh" || ext === ".bash") {
    try {
      execFileSync("bash", ["-n", resolvedPath], {
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"]
      });
      return "";
    } catch (err) {
      const stderr = (err.stderr ? err.stderr.toString() : err.message || "").trim();
      const shortErr = stderr.split("\n").slice(0, 4).join("\n");
      return `\n⚠️ [Peringatan Sintaks Bash — segera perbaiki dengan file_edit]:\n${shortErr}`;
    }
  }

  if (ext === ".py") {
    try {
      execFileSync(
        "python3",
        ["-c", "import ast, sys; ast.parse(open(sys.argv[1], 'rb').read(), sys.argv[1])", resolvedPath],
        { timeout: 3000, stdio: ["ignore", "pipe", "pipe"] }
      );
      return "";
    } catch (err) {
      if (err.code === "ENOENT") return "";
      const stderr = (err.stderr ? err.stderr.toString() : err.message || "").trim();
      const shortErr = stderr.split("\n").slice(-3).join("\n");
      return `\n⚠️ [Peringatan Sintaks Python — segera perbaiki dengan file_edit]:\n${shortErr}`;
    }
  }

  return "";
}

/** Riwayat snapshot file per sesi untuk fitur workspace_undo (maks 25 snapshot / sesi, <= 1 MB per file). */
const fileUndoStacks = new Map();
const MAX_UNDO_PER_SESSION = 25;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
let undoCounter = 0;

function recordFileSnapshot(sessionId, resolvedPath, op) {
  try {
    const sid = String(sessionId || "default");
    const existed = fs.existsSync(resolvedPath);
    let prevContent = null;
    if (existed) {
      const st = fs.statSync(resolvedPath);
      if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return;
      prevContent = fs.readFileSync(resolvedPath, "utf-8");
    }
    if (!fileUndoStacks.has(sid)) fileUndoStacks.set(sid, []);
    const stack = fileUndoStacks.get(sid);
    stack.push({
      id: `undo_${++undoCounter}`,
      ts: Date.now(),
      op,
      resolvedPath,
      sandboxPath: toSandboxPath(resolvedPath, sid),
      existed,
      prevContent
    });
    if (stack.length > MAX_UNDO_PER_SESSION) {
      stack.splice(0, stack.length - MAX_UNDO_PER_SESSION);
    }
  } catch (_) {}
}

/**
 * Pencocokan baris dengan toleransi indentasi/spasi tepi (Fuzzy Line Match).
 * Hanya diterima jika ditemukan TEPAT 1 lokasi unik di dalam file.
 */
function fuzzyLineReplace(content, target, replacement) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const contentLines = content.replace(/\r\n/g, "\n").split("\n");
  const targetLines = target.replace(/\r\n/g, "\n").split("\n");
  const replacementLines = replacement.replace(/\r\n/g, "\n").split("\n");

  const m = targetLines.length;
  if (m === 0 || targetLines.every((l) => l.trim() === "")) {
    return { ok: false, reason: "not_found" };
  }
  if (m > contentLines.length) {
    return { ok: false, reason: "not_found" };
  }

  const trimmedTarget = targetLines.map((l) => l.trim());
  const matches = [];

  for (let i = 0; i <= contentLines.length - m; i++) {
    let allMatch = true;
    for (let k = 0; k < m; k++) {
      if (contentLines[i + k].trim() !== trimmedTarget[k]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) matches.push(i);
  }

  if (matches.length === 0) return { ok: false, reason: "not_found" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", count: matches.length };

  const startIdx = matches[0];
  // Sesuaikan indentasi relatif jika baris non-kosong pertama memiliki selisih spasi
  const firstNonEmptyIdx = targetLines.findIndex((l) => l.trim().length > 0);
  let adjustedReplacement = replacementLines;
  if (firstNonEmptyIdx !== -1) {
    const fileIndent = (contentLines[startIdx + firstNonEmptyIdx].match(/^[ \t]*/) || [""])[0];
    const targetIndent = (targetLines[firstNonEmptyIdx].match(/^[ \t]*/) || [""])[0];
    if (fileIndent !== targetIndent) {
      adjustedReplacement = replacementLines.map((line) => {
        if (!line.trim()) return line;
        if (targetIndent && line.startsWith(targetIndent)) {
          return fileIndent + line.slice(targetIndent.length);
        }
        if (!targetIndent) {
          return fileIndent + line;
        }
        return line;
      });
    }
  }

  const updatedLines = [
    ...contentLines.slice(0, startIdx),
    ...adjustedReplacement,
    ...contentLines.slice(startIdx + m)
  ];
  return {
    ok: true,
    content: updatedLines.join(eol),
    occurrences: 1,
    mode: "fuzzy-indent",
    diffLines: adjustedReplacement.length - m
  };
}

function applySingleEdit(content, target, replacement) {
  let effectiveTarget = target;
  let mode = "exact";

  if (!content.includes(effectiveTarget)) {
    const lfTarget = target.replace(/\r\n/g, "\n");
    const crlfTarget = target.replace(/\n/g, "\r\n");
    if (content.includes(lfTarget)) {
      effectiveTarget = lfTarget;
      mode = "line-ending";
    } else if (content.includes(crlfTarget)) {
      effectiveTarget = crlfTarget;
      mode = "line-ending";
    } else {
      return fuzzyLineReplace(content, target, replacement);
    }
  }

  const occurrences = content.split(effectiveTarget).length - 1;
  const newContent = content.replaceAll(effectiveTarget, replacement);
  const diffLines = replacement.split("\n").length - effectiveTarget.split("\n").length;
  return {
    ok: true,
    content: newContent,
    occurrences,
    mode,
    diffLines
  };
}

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
    recordFileSnapshot(sessionId, resolved, "file_write");
    const strContent = String(content);
    fs.writeFileSync(resolved, strContent, "utf-8");
    const size = Buffer.byteLength(strContent, "utf-8");
    const syntaxWarn = checkFileSyntax(resolved, strContent);
    return `✅ Berhasil menulis ${toSandboxPath(resolved, sessionId)} (${size} bytes)${syntaxWarn}`;
  } catch (err) {
    return `❌ Gagal menulis file: ${err.message}`;
  }
}

/**
 * Tool: file_edit
 * Mengganti satu blok ('target' -> 'replacement') atau banyak blok sekaligus ('edits': [{target, replacement}]).
 * Mendukung pencocokan persis, normalisasi CRLF/LF, dan toleransi indentasi (fuzzy-indent).
 */
async function toolFileEdit({ path: filePath, target, replacement, edits, sessionId }) {
  if (!filePath || typeof filePath !== "string") {
    return "❌ Parameter 'path' wajib berupa string.";
  }

  const editList = [];
  if (typeof target === "string" && target.length > 0) {
    if (typeof replacement !== "string") {
      return "❌ Parameter 'replacement' wajib berupa string (gunakan string kosong \"\" jika ingin menghapus target).";
    }
    editList.push({ target, replacement });
  }
  if (Array.isArray(edits)) {
    for (let i = 0; i < edits.length; i++) {
      const item = edits[i];
      if (!item || typeof item.target !== "string" || item.target.length === 0 || typeof item.replacement !== "string") {
        return `❌ Item edits[${i}] tidak valid: wajib memiliki 'target' (string tidak kosong) dan 'replacement' (string).`;
      }
      editList.push({ target: item.target, replacement: item.replacement });
    }
  }

  if (editList.length === 0) {
    return "❌ Berikan parameter 'target' & 'replacement' atau array 'edits' ([{target, replacement}]).";
  }

  const guard = resolveFilePath(filePath, sessionId);
  if (!guard.ok) return `⛔ ${guard.error}`;
  const resolved = guard.path;

  if (!fs.existsSync(resolved)) {
    return `❌ File '${filePath}' tidak ditemukan. Gunakan tool 'file_write' jika ingin membuat file baru dari nol.`;
  }

  try {
    const originalContent = fs.readFileSync(resolved, "utf-8");
    let workingContent = originalContent;
    let totalOccurrences = 0;
    let totalDiffLines = 0;
    let usedFuzzy = false;

    for (let i = 0; i < editList.length; i++) {
      const { target: t, replacement: r } = editList[i];
      const res = applySingleEdit(workingContent, t, r);
      if (!res.ok) {
        const label = editList.length > 1 ? ` pada edits[${i}]` : "";
        if (res.reason === "ambiguous") {
          return (
            `❌ Target teks${label} ditemukan di ${res.count} lokasi dengan indentasi berbeda dalam '${filePath}'.\n` +
            `Tips: Sertakan 2-3 baris konteks di atas/bawahnya agar lokasi yang dimaksud unik.`
          );
        }
        return (
          `❌ Target teks${label} tidak ditemukan dalam file '${filePath}'.\n` +
          `Tips: Gunakan tool 'file_read' terlebih dahulu untuk memeriksa isi file yang sebenarnya.`
        );
      }
      workingContent = res.content;
      totalOccurrences += res.occurrences;
      totalDiffLines += res.diffLines;
      if (res.mode === "fuzzy-indent") usedFuzzy = true;
    }

    recordFileSnapshot(sessionId, resolved, "file_edit");
    fs.writeFileSync(resolved, workingContent, "utf-8");

    const diffStr = totalDiffLines >= 0 ? `+${totalDiffLines}` : `${totalDiffLines}`;
    const fuzzyNote = usedFuzzy ? " [toleransi indentasi otomatis]" : "";
    const syntaxWarn = checkFileSyntax(resolved, workingContent);

    return (
      `✅ Berhasil mengedit file '${filePath}' (${totalOccurrences} bagian diganti, ${diffStr} baris)${fuzzyNote}.\n` +
      `Dari sandbox terlihat sebagai: ${toSandboxPath(resolved, sessionId)}${syntaxWarn}`
    );
  } catch (err) {
    return `❌ Gagal mengedit file: ${err.message}`;
  }
}

/**
 * Tool: workspace_undo
 * Mengembalikan perubahan file terakhir (dari file_write / file_edit) atau menampilkan daftar riwayat snapshot.
 */
async function toolWorkspaceUndo({ path: filePath, steps = 1, action = "undo", sessionId }) {
  const sid = String(sessionId || "default");
  const stack = fileUndoStacks.get(sid) || [];

  if (action === "list") {
    if (stack.length === 0) {
      return "ℹ️ Belum ada riwayat perubahan file (snapshot) yang tercatat di sesi ini.";
    }
    const lines = [...stack]
      .reverse()
      .map((s, idx) => `${idx + 1}. [${s.op}] ${s.sandboxPath} (${s.existed ? "ubah file" : "buat file baru"}) — ${new Date(s.ts).toLocaleTimeString("id-ID")}`);
    return `⏪ Riwayat Snapshot Undo (${stack.length} perubahan terakhir, terbaru di atas):\n${lines.join("\n")}`;
  }

  if (stack.length === 0) {
    return "❌ Tidak ada riwayat perubahan file yang bisa di-undo di sesi ini.";
  }

  let targetResolved = null;
  if (filePath && typeof filePath === "string" && filePath.trim()) {
    const guard = resolveFilePath(filePath.trim(), sid);
    if (!guard.ok) return `⛔ ${guard.error}`;
    targetResolved = guard.path;
  }

  const count = Math.max(1, Math.min(Number(steps) || 1, 10));
  const restored = [];

  for (let n = 0; n < count; n++) {
    let idx = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (!targetResolved || stack[i].resolvedPath === targetResolved) {
        idx = i;
        break;
      }
    }
    if (idx === -1) break;

    const snap = stack.splice(idx, 1)[0];
    const guard = resolveFilePath(snap.resolvedPath, sid);
    if (!guard.ok) continue;

    if (snap.existed) {
      fs.mkdirSync(path.dirname(guard.path), { recursive: true });
      fs.writeFileSync(guard.path, snap.prevContent, "utf-8");
      restored.push(`• ${snap.sandboxPath}: dikembalikan ke kondisi sebelum ${snap.op}`);
    } else {
      try {
        fs.rmSync(guard.path, { force: true });
      } catch (_) {}
      restored.push(`• ${snap.sandboxPath}: file baru hasil ${snap.op} dihapus kembali`);
    }
  }

  if (restored.length === 0) {
    return `❌ Tidak ditemukan riwayat perubahan untuk '${filePath || "workspace"}' yang bisa di-undo.`;
  }

  return `⏪ Berhasil membatalkan ${restored.length} perubahan file:\n${restored.join("\n")}`;
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

const IGNORED_SEARCH_DIRS = new Set([
  ".git",
  "node_modules",
  ".memory",
  ".bg",
  "__pycache__",
  ".next",
  "dist",
  "build",
  ".cache",
  "venv",
  ".venv"
]);

function matchFilePattern(fileName, pattern) {
  if (!pattern || !String(pattern).trim()) return true;
  const p = String(pattern).trim().toLowerCase();
  const name = fileName.toLowerCase();
  if (p.startsWith("*.")) return name.endsWith(p.slice(1));
  if (p.startsWith(".")) return name.endsWith(p);
  if (p.includes("*")) {
    const escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i").test(name);
  }
  return name.includes(p);
}

/**
 * Tool: code_search
 * Pencarian teks atau pola regex lintas seluruh file kode di dalam workspace sesi.
 */
async function toolCodeSearch({ query, path: searchPath, file_pattern, case_sensitive = false, max_results = 30, sessionId }) {
  if (!query || typeof query !== "string" || !query.trim()) {
    return "❌ Parameter 'query' wajib diisi (teks atau pola regex yang dicari).";
  }

  const guard = resolveFilePath(searchPath || "/workspace", sessionId);
  if (!guard.ok) return `⛔ ${guard.error}`;
  const rootPath = guard.path;

  if (!fs.existsSync(rootPath)) {
    return `❌ Path tidak ditemukan: ${toSandboxPath(rootPath, sessionId)}`;
  }

  const limit = Math.min(Math.max(Number(max_results) || 30, 1), 80);
  const flags = case_sensitive ? "" : "i";
  let matcher;
  try {
    const regex = new RegExp(query, flags);
    matcher = (line) => regex.test(line);
  } catch (_) {
    const needle = case_sensitive ? query : query.toLowerCase();
    matcher = (line) => (case_sensitive ? line : line.toLowerCase()).includes(needle);
  }

  const matches = [];
  let filesScanned = 0;

  const searchOneFile = (fullPath) => {
    if (matches.length >= limit) return;
    if (isSensitiveFile(fullPath)) return;
    try {
      const st = fs.lstatSync(fullPath);
      if (st.isSymbolicLink() || !st.isFile() || st.size > 2 * 1024 * 1024 || st.size === 0) return;
      const buf = fs.readFileSync(fullPath);
      // Lewati file biner (mengandung null byte di 1024 byte pertama)
      const checkLen = Math.min(buf.length, 1024);
      for (let i = 0; i < checkLen; i++) {
        if (buf[i] === 0) return;
      }
      filesScanned++;
      const lines = buf.toString("utf-8").split(/\r?\n/);
      const displayPath = toSandboxPath(fullPath, sessionId);
      for (let idx = 0; idx < lines.length; idx++) {
        if (matcher(lines[idx])) {
          matches.push(`${displayPath}:${idx + 1}: ${lines[idx].trim().slice(0, 180)}`);
          if (matches.length >= limit) break;
        }
      }
    } catch (_) {}
  };

  const walk = (dir) => {
    if (matches.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= limit) break;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_SEARCH_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (!matchFilePattern(entry.name, file_pattern)) continue;
        searchOneFile(full);
      }
    }
  };

  const rootStat = fs.statSync(rootPath);
  if (rootStat.isFile()) {
    searchOneFile(rootPath);
  } else if (rootStat.isDirectory()) {
    walk(rootPath);
  }

  if (matches.length === 0) {
    return `🔍 Tidak ditemukan kecocokan untuk "${query}" (${filesScanned} file diperiksa di ${toSandboxPath(rootPath, sessionId)}).`;
  }

  const moreNote = matches.length >= limit ? `\n\n(Menampilkan ${limit} hasil pertama. Persempit query atau isi 'path' / 'file_pattern' jika perlu.)` : "";
  return truncate(
    `🔎 Hasil pencarian "${query}" (${matches.length} baris cocok dari ${filesScanned} file):\n\n` +
      matches.join("\n") +
      moreNote
  );
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
  toolCodeSearch,
  toolWorkspaceUndo,
  checkFileSyntax,
  toolSendPhoto,
  toolSendFile,
  findWorkspaceFile
};
