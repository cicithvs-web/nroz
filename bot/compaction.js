/**
 * bot/compaction.js — Summary buffer: memadatkan obrolan lama jadi ringkasan di background.
 */

const { getMessagesToSummarize, updateChatSummary } = require("../dbHelper.js");
const { listActiveDecisions } = require("../workspaceMemoryManager.js");
const { buildDecisionExtractionPrompt, parseCompactionOutput, applyAutoDecisions } = require("./autoMemory");
const { getClient, getConfig } = require("./config");

const activeSummaries = new Set();

// Batas ukuran ringkasan (karakter). Ringkasan ikut dikirim di setiap giliran, jadi harus dibatasi.
const SUMMARY_MAX_CHARS = 3500;
// Potongan per pesan yang dikirim ke peringkas. Cukup panjang agar path/port/nama file ikut terbawa.
const MESSAGE_SNIPPET_CHARS = 800;

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
      .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, MESSAGE_SNIPPET_CHARS)}`)
      .join("\n\n");

    const prompt =
`Kamu adalah asisten pengelola memori percakapan AI. Tugasmu memperbarui ringkasan terstruktur obrolan antara User dan Assistant agar konteks jangka panjang tidak hilang.

${currentSummary ? `[Ringkasan Sebelumnya]:\n${currentSummary}\n\n` : ""}[Potongan Obrolan Baru yang Perlu Dirangkum]:
${formatted}

Instruksi:
1. Gabungkan ringkasan sebelumnya dengan obrolan baru. PERTAHANKAN detail lama yang masih relevan; hapus hanya yang jelas sudah usang, selesai, atau dibantah info baru.
2. Tulis dalam bahasa Indonesia, tanpa basa-basi atau kata pembuka, persis dengan bagian berikut (lewati bagian yang kosong):
Profil & preferensi user:
- (nama, bahasa/gaya jawaban yang diminta, kebiasaan, preferensi)
Topik & tugas berjalan:
- (apa yang sedang dikerjakan, sampai tahap mana, apa yang belum selesai)
Fakta & detail teknis:
- (path file, nama proyek, port, URL, perintah, versi, nama variabel/tabel, angka penting; tulis persis seperti aslinya)
Kesepakatan & pertanyaan terbuka:
- (hal yang sudah disetujui, hal yang masih menunggu jawaban user)
3. Satu butir = satu fakta singkat. Jangan mengarang. Total ringkasan maksimal sekitar 1500 karakter, kecuali butuh lebih untuk menjaga detail teknis.
${buildDecisionExtractionPrompt(listActiveDecisions(chatId))}`;

    const res = await getClient().chat.completions.create({
      model: getConfig().model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3
    });

    const { summary, decisions } = parseCompactionOutput(res.choices[0]?.message?.content);
    let newSummary = summary;
    if (newSummary && newSummary.length > 0) {
      if (newSummary.length > SUMMARY_MAX_CHARS) {
        newSummary = newSummary.slice(0, SUMMARY_MAX_CHARS).trimEnd() + "\n[...dipotong]";
      }
      const result = await updateChatSummary(chatId, newSummary, upToTs);
      if (!result.saved) {
        console.warn(`[Summary Compaction] Ringkasan chat ${chatId} TIDAK tersimpan: ${result.reason}`);
        return;
      }
      console.log(`[Summary Compaction] Berhasil memadatkan memori chat ${chatId} (${messagesToSummarize.length} pesan, sampai ts ${upToTs})`);

      // Keputusan otomatis hanya ditulis jika ringkasan benar-benar tersimpan.
      if (decisions.length > 0) {
        const written = applyAutoDecisions(chatId, decisions);
        if (written > 0) console.log(`[Auto Memory] ${written} keputusan otomatis dicatat untuk chat ${chatId}`);
      }
    }
  } catch (err) {
    console.warn(`[Summary Compaction] Gagal memadatkan chat ${chatId}:`, err.message);
  } finally {
    activeSummaries.delete(key);
  }
}

module.exports = { triggerBackgroundCompaction };
