/**
 * tools/knowledge.js — Tool pencarian semantik: search_knowledge (RAG, lihat bot/knowledge.js).
 */

const knowledge = require("../bot/knowledge.js");

/**
 * Tool: search_knowledge
 * Mencari cuplikan relevan dari dokumen yang pernah di-upload user dan arsip percakapan
 * memakai kemiripan semantik (embedding), bukan sekadar cocok kata kunci.
 */
async function toolSearchKnowledge({ query, source, limit, sessionId }) {
  if (!query || typeof query !== "string" || !query.trim()) {
    return "❌ Parameter 'query' wajib diisi.";
  }
  const { results, error } = await knowledge.searchKnowledge(sessionId, query, {
    limit: Number(limit) || 6,
    source
  });

  if (error) {
    return `⚠️ Pencarian semantik tidak tersedia: ${error}\n` +
      `Gunakan search_raw_memory (cocok kata kunci) sebagai gantinya.`;
  }
  if (!results.length) {
    return `🔍 Tidak ada potongan memori/dokumen yang cocok dengan "${query.trim().slice(0, 80)}".`;
  }
  return `🔍 Hasil pencarian semantik untuk "${query.trim().slice(0, 80)}" (${results.length} potongan):\n\n` +
    knowledge.formatResults(results);
}

module.exports = { toolSearchKnowledge };
