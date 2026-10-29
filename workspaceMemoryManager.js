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

const WORKSPACE_BASE = path.join(__dirname, "workspace");

function getSafeSessionId(sessionId) {
  return String(sessionId || "default").trim().replace(/[^a-zA-Z0-9_\-]/g, "_");
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

  // Buat semua direktori jika belum ada
  for (const dir of [baseDir, uploadsDir, workDir, artifactsDir, memoryDir, rawDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
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
 * Menambahkan keputusan / pilihan user ke .memory/decisions.md
 * @param {string} sessionId
 * @param {string} decision - Teks ringkas keputusan user
 * @param {string} [category="Umum"]
 */
function recordDecision(sessionId, decision, category = "Umum") {
  const { decisionsFile } = ensureWorkspaceStructure(sessionId);
  const nowStr = new Date().toISOString().slice(0, 16).replace("T", " ");
  const cleanDecision = String(decision || "").trim();

  if (!cleanDecision) {
    throw new Error("Teks keputusan (decision) tidak boleh kosong.");
  }

  const entry = `- **[${nowStr}] [${category}]**: ${cleanDecision}\n`;
  fs.appendFileSync(decisionsFile, entry, "utf-8");
  return { success: true, entry: entry.trim(), file: decisionsFile };
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

/**
 * Mencari cuplikan percakapan masa lalu di .memory/raw/
 */
function searchRawMemory(sessionId, query, limit = 5) {
  const { rawDir } = ensureWorkspaceStructure(sessionId);
  if (!fs.existsSync(rawDir)) return [];

  const q = String(query || "").toLowerCase().trim();
  if (!q) return [];

  const files = fs.readdirSync(rawDir)
    .filter((f) => f.startsWith("chat_") && f.endsWith(".jsonl"))
    .sort()
    .reverse(); // Terbaru lebih dulu

  const matches = [];

  for (const file of files) {
    if (matches.length >= limit) break;
    const fullPath = path.join(rawDir, file);
    try {
      const lines = fs.readFileSync(fullPath, "utf-8").split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (matches.length >= limit) break;
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.content && entry.content.toLowerCase().includes(q)) {
            matches.push({
              file,
              timestamp: entry.timestamp,
              role: entry.role,
              content: entry.content.slice(0, 600)
            });
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  return matches;
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
      // Hanya sertakan jika ada entri keputusan (ada baris yang diawali dengan '- **[')
      if (decContent.includes("- **[")) {
        // Ambil maksimal 15 keputusan terakhir agar tidak terlalu panjang
        const lines = decContent.split("\n");
        const header = lines.slice(0, 5).join("\n");
        const entries = lines.filter((l) => l.startsWith("- **[")).slice(-15).join("\n");
        parts.push(`[Catatan Keputusan & Pilihan User]:\n${entries}`);
      }
    }

    if (fs.existsSync(projectContextFile)) {
      const ctxContent = fs.readFileSync(projectContextFile, "utf-8").trim();
      if (ctxContent && !ctxContent.includes("Belum ada proyek aktif")) {
        parts.push(`[Konteks & Status Proyek Aktif]:\n${ctxContent}`);
      }
    }

    return parts.join("\n\n");
  } catch (err) {
    console.warn(`[Workspace Memory] Gagal memuat memory inject untuk sesi ${sessionId}:`, err.message);
    return "";
  }
}

module.exports = {
  ensureWorkspaceStructure,
  appendRawLog,
  recordDecision,
  updateProjectContext,
  searchRawMemory,
  getInjectedMemoryContext,
  WORKSPACE_BASE
};
