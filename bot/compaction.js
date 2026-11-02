/**
 * bot/compaction.js — Summary buffer: memadatkan obrolan lama jadi ringkasan di background.
 */

const { getMessagesToSummarize, updateChatSummary } = require("../onlyxHelper.js");
const { getClient, getConfig } = require("./config");

const activeSummaries = new Set();

async function triggerBackgroundCompaction(chatId) {
  const key = String(chatId);
  if (activeSummaries.has(key)) return;

  activeSummaries.add(key);
  try {
    // Ambil pesan lama jika obrolan yang belum dipadatkan >= 10 pesan; sisakan 4 terbaru.
    const data = await getMessagesToSummarize(chatId, 4, 10);
    if (!data) return;

    const { currentSummary, messagesToSummarize, upToTs } = data;

    const formatted = messagesToSummarize
      .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 400)}`)
      .join("\n\n");

    const prompt =
`Kamu adalah asisten pengelola memori percakapan AI. Tugasmu adalah memperbarui ringkasan obrolan antara User dan Assistant agar tetap padat dan mempertahankan konteks jangka panjang.

${currentSummary ? `[Ringkasan Sebelumnya]:\n${currentSummary}\n\n` : ""}[Potongan Obrolan Baru yang Perlu Dirangkum]:
${formatted}

Instruksi:
1. Buat ringkasan baru yang menggabungkan konteks lama dan obrolan baru di atas.
2. Catat informasi krusial seperti: nama user, preferensi, topik diskusi, dan fakta penting.
3. Tulis maksimal 3-5 kalimat ringkas berbahasa Indonesia tanpa basa-basi atau kata pembuka.`;

    const res = await getClient().chat.completions.create({
      model: getConfig().model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3
    });

    const newSummary = res.choices[0]?.message?.content?.trim();
    if (newSummary && newSummary.length > 0) {
      await updateChatSummary(chatId, newSummary, upToTs);
      console.log(`[Summary Compaction] Berhasil memadatkan memori chat ${chatId}`);
    }
  } catch (err) {
    console.warn(`[Summary Compaction] Gagal memadatkan chat ${chatId}:`, err.message);
  } finally {
    activeSummaries.delete(key);
  }
}

module.exports = { triggerBackgroundCompaction };
