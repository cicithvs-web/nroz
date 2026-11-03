/**
 * workspaceMemoryManager.js — Sistem Pengelola Struktur Workspace & File-Based Memory AI
 *
 * Struktur Folder per Sesi:
 * /workspace/<sessionId>/
 * ├── uploads/              # File mentah kiriman user (ZIP, PDF, gambar, audio) — readonly
 * ├── work/                 # Tempat kerja AI (ngoding, install package, test, run server)
 * ├── artifacts/            # Hasil final siap pakai (MP4 render, ZIP final, build output)
 * └── .memory/              # Pusat Memori AI
 *     ├── decisions.md      # Catatan kesepakatan & pilihan user (Pilihan A/B/C, preferensi)
 *     ├── project_context.md# State & status proyek saat ini (port aktif, file utama, service)
 *     └── raw/              # Log percakapan mentah (cold storage)
 *         └── chat_YYYY-MM-DD.jsonl
 */

const fs = require("fs");
const path = require("path");
const { isInside } = require("./lib/pathGuard");
const { writeTextAtomic } = require("./lib/atomicFile");

const WORKSPACE_BASE = path.join(__dirname, "workspace");

function getSafeSessionId(sessionId) {
  return String(sessionId || "default").trim().replace(/[^a-zA-Z0-9_\-]/g, "_");
}

/**
 * Sandbox (root di container) bisa mengganti folder seperti uploads/ dengan symlink ke path
 * host (misal /root/.ssh). Bot menulis ke folder ini dari HOST, jadi symlink yang keluar dari
 * workspace dihapus (hanya link-nya, bukan targetnya) lalu folder aslinya dibuat ulang.
 */
function ensureRealDirInside(dir, baseDir) {
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) {
      let target = null;
      try {
        target = fs.realpathSync(dir);
      } catch (_) {}
      if (!target || !isInside(target, fs.realpathSync(baseDir))) {
        console.warn(`[Workspace Memory] Symlink ${dir} -> ${target} keluar dari workspace, diganti folder biasa.`);
        fs.unlinkSync(dir);
      }
    } else if (!st.isDirectory()) {
      fs.rmSync(dir, { force: true });
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Memastikan struktur folder workspace dan file memori untuk sesi telah terbentuk.
 * @param {string} sessionId
 * @returns {object} Path direktori dan file lengkap
 */
function ensureWorkspaceStructure(sessionId) {
  const safeSession = getSafeSessionId(sessionId);
  const baseDir = path.join(WORKSPACE_BASE, safeSession);

  const uploadsDir = path.join(baseDir, "uploads");
  const workDir = path.join(baseDir, "work");
  const artifactsDir = path.join(baseDir, "artifacts");
  const memoryDir = path.join(baseDir, ".memory");
  const rawDir = path.join(memoryDir, "raw");

  const decisionsFile = path.join(memoryDir, "decisions.md");
  const projectContextFile = path.join(memoryDir, "project_context.md");

  // Buat semua direktori jika belum ada (dan pastikan bukan symlink ke luar workspace)
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  for (const dir of [uploadsDir, workDir, artifactsDir, memoryDir, rawDir]) {
    ensureRealDirInside(dir, baseDir);
  }

  // Buat file template decisions.md jika belum ada
  if (!fs.existsSync(decisionsFile)) {
    const defaultDecisions = [
      "# 📋 Catatan Pilihan & Keputusan User",
      "Dokumen ini mencatat kesepakatan, pilihan pendekatan, atau preferensi yang ditentukan user.",
      "AI akan selalu mengingat poin-poin di bawah ini dalam percakapan.",
      "",
      "---",
      ""
    ].join("\n");
    fs.writeFileSync(decisionsFile, defaultDecisions, "utf-8");
  }

  // Buat file template project_context.md jika belum ada
  if (!fs.existsSync(projectContextFile)) {
    const defaultContext = [
      "# 🛠️ Konteks & Status Proyek Aktif",
      "- Status: Belum ada proyek aktif",
      "- File Utama: -",
      "- Service / Port Aktif: -",
      "- Catatan Terakhir: Sesi baru dimulai",
      ""
    ].join("\n");
    fs.writeFileSync(projectContextFile, defaultContext, "utf-8");
  }

  return {
    baseDir,
    uploadsDir,
    workDir,
    artifactsDir,
    memoryDir,
    rawDir,
    decisionsFile,
    projectContextFile,
    // Path relatif dalam container sandbox Docker (/workspace/...)
    sandbox: {
      base: "/workspace",
      uploads: "/workspace/uploads",
      work: "/workspace/work",
      artifacts: "/workspace/artifacts",
      memory: "/workspace/.memory",
      decisions: "/workspace/.memory/decisions.md",
      projectContext: "/workspace/.memory/project_context.md",
      raw: "/workspace/.memory/raw"
    }
  };
}

/**
 * Mencatat log percakapan mentah ke .memory/raw/chat_YYYY-MM-DD.jsonl
 */
function appendRawLog(sessionId, role, text, extra = {}) {
  try {
    const { rawDir } = ensureWorkspaceStructure(sessionId);
    const dateStr = new Date().toISOString().slice(0, 10);
    const logFile = path.join(rawDir, `chat_${dateStr}.jsonl`);

    const entry = {
      timestamp: new Date().toISOString(),
      role,
      content: String(text || ""),
      ...extra
    };

    fs.appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.warn(`[Workspace Memory] Gagal mencatat raw log chat sesi ${sessionId}:`, err.message);
  }
}

/**
 * Format baris keputusan di decisions.md:
 *   aktif   : - **[2026-11-02 10:00] [Kategori]**: teks
 *   dicabut : - ~~**[2026-11-02 10:00] [Kategori]**: teks~~ _(dicabut 2026-11-03 09:00: alasan)_
 * ID keputusan = urutan kemunculannya (aktif maupun dicabut) mulai dari 1. Entri dicabut tetap
 * disimpan sebagai riwayat, jadi ID tidak bergeser.
 */
const ACTIVE_DECISION_RE = /^- \*\*\[/;
const REVOKED_DECISION_RE = /^- ~~\*\*\[/;
const DECISIONS_INJECT_BUDGET = 4000; // karakter

function oneLine(text) {
  return String(text || "").replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function parseDecisions(content) {
  const lines = content.split("\n");
  const entries = [];
  lines.forEach((line, lineIdx) => {
    const active = ACTIVE_DECISION_RE.test(line);
    if (active || REVOKED_DECISION_RE.test(line)) {
      entries.push({ id: entries.length + 1, lineIdx, active, line });
    }
  });
  return { lines, entries };
}

function nowStamp() {
  return new Date().toISOString().slice(0, 16).replace("T", " ");
}

/** Daftar keputusan aktif: [{ id, category, text }]. */
function listActiveDecisions(sessionId) {
  const { decisionsFile } = ensureWorkspaceStructure(sessionId);
  const { entries } = parseDecisions(fs.readFileSync(decisionsFile, "utf-8"));
  return entries
    .filter((e) => e.active)
    .map((e) => {
      const m = e.line.match(/^- \*\*\[[^\]]*\] \[([^\]]*)\]\*\*: (.*)$/);
      return { id: e.id, category: m ? m[1] : "Umum", text: m ? m[2] : e.line.slice(2) };
    });
}

/**
 * Mencabut keputusan (tidak dihapus, hanya ditandai dicabut agar tetap jadi riwayat).
 * @returns {{id:number, text:string}} baris yang dicabut
 */
function revokeDecision(sessionId, id, reason = "") {
  const { decisionsFile } = ensureWorkspaceStructure(sessionId);
  const num = Number(id);
  if (!Number.isInteger(num) || num < 1) throw new Error("ID keputusan harus berupa angka bulat >= 1.");

  const { lines, entries } = parseDecisions(fs.readFileSync(decisionsFile, "utf-8"));
  const target = entries.find((e) => e.id === num);
  if (!target) throw new Error(`Keputusan #${num} tidak ditemukan.`);
  if (!target.active) throw new Error(`Keputusan #${num} sudah dicabut sebelumnya.`);

  const why = oneLine(reason);
  lines[target.lineIdx] = `- ~~${target.line.slice(2)}~~ _(dicabut ${nowStamp()}${why ? `: ${why}` : ""})_`;
  writeTextAtomic(decisionsFile, lines.join("\n"));
  return { id: num, text: target.line.slice(2) };
}

/**
 * Menambahkan keputusan / pilihan user ke .memory/decisions.md
 * @param {string} sessionId
 * @param {string} decision - Teks ringkas keputusan user
 * @param {string} [category="Umum"]
 * @param {number} [supersedes] - ID keputusan lama yang digantikan (otomatis dicabut)
 */
function recordDecision(sessionId, decision, category = "Umum", supersedes = null) {
  const { decisionsFile } = ensureWorkspaceStructure(sessionId);
  const cleanDecision = oneLine(decision);
  const cleanCategory = oneLine(category).replace(/[\[\]]/g, "") || "Umum";

  if (!cleanDecision) {
    throw new Error("Teks keputusan (decision) tidak boleh kosong.");
  }

  let replaced = null;
  if (supersedes !== null && supersedes !== undefined && supersedes !== "") {
    // Dicabut dulu: kalau ID tidak valid, error dilempar sebelum ada yang ditulis.
    replaced = revokeDecision(sessionId, supersedes, "digantikan keputusan baru");
  }

  const content = fs.readFileSync(decisionsFile, "utf-8");
  const id = parseDecisions(content).entries.length + 1;
  const entry = `- **[${nowStamp()}] [${cleanCategory}]**: ${cleanDecision}`;
  const prefix = content.endsWith("\n") || content === "" ? "" : "\n";
  fs.appendFileSync(decisionsFile, `${prefix}${entry}\n`, "utf-8");
  return { success: true, id, entry: `#${id} ${entry.slice(2)}`, replaced, file: decisionsFile };
}

/**
 * Memperbarui ringkasan project context di .memory/project_context.md
 */
function updateProjectContext(sessionId, { summary, active_files, active_services, status = "Aktif" }) {
  const { projectContextFile } = ensureWorkspaceStructure(sessionId);
  const nowStr = new Date().toISOString().slice(0, 16).replace("T", " ");

  const filesList = Array.isArray(active_files) && active_files.length > 0
    ? active_files.map((f) => `  - \`${f}\``).join("\n")
    : "  - (tidak ada file aktif spesifik)";

  const servicesStr = active_services ? String(active_services).trim() : "-";
  const summaryStr = summary ? String(summary).trim() : "-";

  const content = [
    "# 🛠️ Konteks & Status Proyek Aktif",
    `*Terakhir diperbarui: ${nowStr}*`,
    "",
    `- **Status Proyek**: ${status}`,
    `- **Ringkasan**: ${summaryStr}`,
    `- **File Utama / Aktif**:`,
    filesList,
    `- **Service / Port Aktif**: ${servicesStr}`,
    ""
  ].join("\n");

  fs.writeFileSync(projectContextFile, content, "utf-8");
  return { success: true, file: projectContextFile };
}

const SEARCH_STOPWORDS = new Set([
  "yang", "dan", "di", "ke", "dari", "itu", "ini", "apa", "kita", "kamu", "aku", "saya", "untuk",
  "dengan", "pada", "adalah", "ada", "atau", "tadi", "kemarin", "dulu", "waktu", "lalu", "tentang",
  "the", "and", "for", "was", "what", "did", "we", "you", "about"
]);
const SEARCH_SNIPPET_CHARS = 600;
const SEARCH_MAX_LIMIT = 20;
const SEARCH_MAX_SCANNED_LINES = 20000;

/** Memecah query jadi kata kunci (huruf/angka). Kata umum dibuang, kecuali semuanya kata umum. */
function tokenizeQuery(query) {
  const all = [...new Set(String(query || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])]
    .filter((t) => t.length >= 2);
  const meaningful = all.filter((t) => !SEARCH_STOPWORDS.has(t));
  return meaningful.length > 0 ? meaningful : all;
}

/** Potongan teks ±SEARCH_SNIPPET_CHARS di sekitar kemunculan pertama kata yang cocok. */
function buildSnippet(content, lower, tokens) {
  if (content.length <= SEARCH_SNIPPET_CHARS) return content;
  let pos = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  const start = Math.max(0, Math.min(pos - Math.floor(SEARCH_SNIPPET_CHARS / 3), content.length - SEARCH_SNIPPET_CHARS));
  const end = start + SEARCH_SNIPPET_CHARS;
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

/**
 * Mencari cuplikan percakapan masa lalu di .memory/raw/
 *
 * Query dipecah jadi kata kunci; pesan harus memuat minimal separuh kata kunci (di posisi mana pun).
 * Hasil diurutkan berdasarkan skor: proporsi kata cocok, bonus jika frasa utuh muncul, dan bonus
 * kecil untuk pesan yang lebih baru. Cuplikan diambil di sekitar kata yang cocok.
 */
function searchRawMemory(sessionId, query, limit = 5) {
  const { rawDir } = ensureWorkspaceStructure(sessionId);
  if (!fs.existsSync(rawDir)) return [];

  const phrase = String(query || "").toLowerCase().trim();
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  const maxResults = Math.min(Math.max(Math.floor(Number(limit)) || 5, 1), SEARCH_MAX_LIMIT);
  const minMatched = Math.max(1, Math.ceil(tokens.length / 2));
  const now = Date.now();

  const files = fs.readdirSync(rawDir)
    .filter((f) => f.startsWith("chat_") && f.endsWith(".jsonl"))
    .sort()
    .reverse(); // Terbaru lebih dulu

  const candidates = [];
  let scanned = 0;

  outer: for (const file of files) {
    let lines;
    try {
      lines = fs.readFileSync(path.join(rawDir, file), "utf-8").split("\n");
    } catch (_) {
      continue;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      if (++scanned > SEARCH_MAX_SCANNED_LINES) break outer;

      // Saringan cepat sebelum JSON.parse: baris harus memuat minimal satu kata kunci.
      const rawLower = lines[i].toLowerCase();
      if (!tokens.some((t) => rawLower.includes(t))) continue;

      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch (_) {
        continue;
      }
      if (!entry || typeof entry.content !== "string") continue;

      const lower = entry.content.toLowerCase();
      const matched = tokens.filter((t) => lower.includes(t));
      if (matched.length < minMatched) continue;

      const ageDays = Math.max(0, (now - (Date.parse(entry.timestamp) || now)) / 86400_000);
      const score =
        matched.length / tokens.length +
        (phrase && lower.includes(phrase) ? 0.5 : 0) +
        0.1 / (1 + ageDays / 30);

      candidates.push({
        file,
        timestamp: entry.timestamp || "",
        role: entry.role || "?",
        content: buildSnippet(entry.content, lower, matched),
        score
      });
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp))
    .slice(0, maxResults);
}

/**
 * Membaca decisions.md dan project_context.md untuk diselipkan ke system prompt.
 * Ringkas, hemat token, dan memberikan AI kesadaran proyek yang konsisten.
 */
function getInjectedMemoryContext(sessionId) {
  try {
    const { decisionsFile, projectContextFile } = ensureWorkspaceStructure(sessionId);
    const parts = [];

    if (fs.existsSync(decisionsFile)) {
      const decContent = fs.readFileSync(decisionsFile, "utf-8").trim();
      const active = parseDecisions(decContent).entries.filter((e) => e.active);
      if (active.length > 0) {
        // Semua keputusan aktif disertakan (terbaru diprioritaskan) sampai batas karakter.
        const picked = [];
        let used = 0;
        for (let i = active.length - 1; i >= 0; i--) {
          const text = `#${active[i].id} ${active[i].line.slice(2)}`;
          if (picked.length > 0 && used + text.length > DECISIONS_INJECT_BUDGET) break;
          picked.unshift(text);
          used += text.length + 1;
        }
        const omitted = active.length - picked.length;
        const note = omitted > 0
          ? `\n(${omitted} keputusan lama tidak ditampilkan; baca /workspace/.memory/decisions.md jika perlu.)`
          : "";
        parts.push(
          `[Catatan Keputusan & Pilihan User]:\n${picked.join("\n")}${note}\n` +
          "Jika user mengubah/membatalkan salah satu keputusan di atas, panggil record_decision dengan supersedes=<nomor #> " +
          "(atau forget_decision) supaya yang lama tidak lagi berlaku."
        );
      }
    }

    if (fs.existsSync(projectContextFile)) {
      const ctxContent = fs.readFileSync(projectContextFile, "utf-8").trim();
      if (ctxContent && !ctxContent.includes("Belum ada proyek aktif")) {
        parts.push(`[Konteks & Status Proyek Aktif]:\n${ctxContent}`);
      }
    }

    const checkpoint = formatTurnCheckpoint(loadTurnCheckpoint(sessionId));
    if (checkpoint) {
      parts.push(`[Pekerjaan Tertunda dari Giliran Sebelumnya]:\n${checkpoint}`);
    }

    return parts.join("\n\n");
  } catch (err) {
    console.warn(`[Workspace Memory] Gagal memuat memory inject untuk sesi ${sessionId}:`, err.message);
    return "";
  }
}

/**
 * CHECKPOINT GILIRAN YANG TERPOTONG
 *
 * Riwayat percakapan hanya menyimpan jawaban final, bukan tool call. Kalau giliran berhenti
 * sebelum selesai (batas langkah, /stop, atau error AI), langkah yang sudah dikerjakan
 * disimpan di .memory/last_turn.json lalu diselipkan ke system prompt giliran berikutnya,
 * supaya "lanjutkan" benar-benar meneruskan dari titik terakhir. Checkpoint dihapus begitu
 * ada giliran yang selesai normal.
 */
const CHECKPOINT_MAX_STEPS = 60;
const CHECKPOINT_STATUS_LABEL = {
  limit: "berhenti karena batas langkah maraton tercapai",
  stopped: "dihentikan user lewat /stop",
  error: "terputus karena AI gagal dihubungi"
};

function checkpointFile(sessionId) {
  return path.join(ensureWorkspaceStructure(sessionId).memoryDir, "last_turn.json");
}

function saveTurnCheckpoint(sessionId, { status, userRequest, steps, lastAssistantNote }) {
  try {
    const data = {
      status,
      userRequest: String(userRequest || "").slice(0, 800),
      steps: (steps || []).slice(-CHECKPOINT_MAX_STEPS),
      totalSteps: (steps || []).length,
      lastAssistantNote: String(lastAssistantNote || "").slice(0, 600),
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(checkpointFile(sessionId), JSON.stringify(data, null, 2), "utf-8");
    return data;
  } catch (err) {
    console.warn(`[Workspace Memory] Gagal menyimpan checkpoint sesi ${sessionId}:`, err.message);
    return null;
  }
}

function loadTurnCheckpoint(sessionId) {
  try {
    const file = checkpointFile(sessionId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (_) {
    return null;
  }
}

function clearTurnCheckpoint(sessionId) {
  try {
    fs.rmSync(checkpointFile(sessionId), { force: true });
  } catch (_) {}
}

/** Teks checkpoint untuk system prompt. */
function formatTurnCheckpoint(cp) {
  if (!cp || !Array.isArray(cp.steps)) return "";
  const skipped = (cp.totalSteps || cp.steps.length) - cp.steps.length;
  const lines = cp.steps.map((s) => `${s.n}. ${s.ok ? "✅" : "❌"} ${s.desc}${s.result ? ` → ${s.result}` : ""}`);
  return [
    `Giliran sebelumnya ${CHECKPOINT_STATUS_LABEL[cp.status] || cp.status} (${cp.savedAt}).`,
    `Permintaan user saat itu: ${cp.userRequest || "-"}`,
    `Langkah yang sudah dikerjakan (${cp.totalSteps || cp.steps.length} total${skipped > 0 ? `, ${skipped} langkah awal tidak ditampilkan` : ""}):`,
    ...lines,
    cp.lastAssistantNote ? `Catatan terakhir AI: ${cp.lastAssistantNote}` : "",
    "Jika user meminta lanjut, teruskan dari langkah terakhir. Jangan ulangi langkah yang sudah ✅ kecuali perlu diverifikasi; perbaiki langkah ❌ lebih dulu."
  ].filter(Boolean).join("\n");
}

module.exports = {
  ensureWorkspaceStructure,
  appendRawLog,
  recordDecision,
  revokeDecision,
  listActiveDecisions,
  updateProjectContext,
  searchRawMemory,
  getInjectedMemoryContext,
  saveTurnCheckpoint,
  loadTurnCheckpoint,
  clearTurnCheckpoint,
  formatTurnCheckpoint,
  WORKSPACE_BASE
};
