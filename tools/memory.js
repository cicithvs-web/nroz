/**
 * tools/memory.js — Tool memori workspace: record_decision, update_project_context, search_raw_memory.
 */

const { recordDecision, updateProjectContext, searchRawMemory } = require("../workspaceMemoryManager.js");

/**
 * Tool: record_decision
 * Mencatat keputusan, kesepakatan, atau pilihan user ke .memory/decisions.md
 */
async function toolRecordDecision({ decision, category, sessionId }) {
  if (!decision) return "❌ Parameter 'decision' wajib diisi.";
  try {
    const res = recordDecision(sessionId || "default", decision, category || "Umum");
    return `✅ Keputusan berhasil dicatat ke .memory/decisions.md:\n${res.entry}`;
  } catch (err) {
    return `❌ Gagal mencatat keputusan: ${err.message}`;
  }
}

/**
 * Tool: update_project_context
 * Memperbarui status proyek terkini di .memory/project_context.md
 */
async function toolUpdateProjectContext({ summary, active_files, active_services, status, sessionId }) {
  if (!summary && !active_files) return "❌ Minimal sertakan parameter 'summary' atau 'active_files'.";
  try {
    updateProjectContext(sessionId || "default", {
      summary,
      active_files,
      active_services,
      status: status || "Dalam Pengerjaan"
    });
    return `✅ Status proyek berhasil diperbarui di .memory/project_context.md`;
  } catch (err) {
    return `❌ Gagal memperbarui status proyek: ${err.message}`;
  }
}

/**
 * Tool: search_raw_memory
 * Mencari cuplikan pada arsip percakapan mentah masa lalu di .memory/raw/
 */
async function toolSearchRawMemory({ query, limit, sessionId }) {
  if (!query) return "❌ Parameter 'query' wajib diisi.";
  try {
    const matches = searchRawMemory(sessionId || "default", query, Number(limit) || 5);
    if (!matches.length) {
      return `🔍 Tidak ditemukan arsip obrolan yang cocok dengan kata kunci "${query}".`;
    }
    const formatted = matches
      .map((m, idx) => `[Arsip #${idx + 1}] (${m.timestamp.slice(0, 16)} - ${m.role.toUpperCase()}):\n${m.content}`)
      .join("\n\n---\n\n");
    return `🔍 Ditemukan ${matches.length} arsip obrolan relevan:\n\n${formatted}`;
  } catch (err) {
    return `❌ Gagal mencari arsip obrolan: ${err.message}`;
  }
}


module.exports = { toolRecordDecision, toolUpdateProjectContext, toolSearchRawMemory };
