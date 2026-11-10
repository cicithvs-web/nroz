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

/**
 * Tool: save_knowledge
 * Menyimpan informasi penting, dokumentasi teknis, hasil riset, atau catatan arsitektur
 * ke dalam memori semantik jangka panjang (PostgreSQL pgvector) agar dapat dicari kembali lewat search_knowledge.
 */
async function toolSaveKnowledge({ title, content, sessionId }) {
  if (!content || typeof content !== "string" || !content.trim()) {
    return "❌ Parameter 'content' (isi pengetahuan yang ingin disimpan) wajib diisi.";
  }
  const cleanTitle = String(title || "catatan").trim().slice(0, 80);
  const slug = cleanTitle
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "catatan";
  const sourceLabel = `note:${slug}`;
  const fullText = `[Judul: ${cleanTitle}]\n${content.trim()}`;

  const res = await knowledge.ingestText(sessionId || "default", sourceLabel, fullText);
  if (res.skipped && !res.stored) {
    return `⚠️ Gagal menyimpan ke memori semantik (pgvector): ${res.skipped}`;
  }
  return (
    `🧠 Pengetahuan "${cleanTitle}" berhasil diindeks ke memori semantik (pgvector)!\n` +
    `• Sumber: ${sourceLabel}\n` +
    `• Potongan tersimpan: ${res.stored} chunk` +
    (res.skipped ? ` (catatan: ${res.skipped})` : "") +
    `\nPengetahuan ini bersifat permanen lintas topik dan dapat dicari kapan saja menggunakan tool 'search_knowledge'.`
  );
}

module.exports = { toolSearchKnowledge, toolSaveKnowledge };
