// Tes cepat koneksi & perilaku PostgreSQL (dbHelper). Jalankan: npm run test-db
// Aman: pakai chat id palsu dan semua data tes dihapus lagi di akhir.
// Butuh DATABASE_URL di .env yang menunjuk ke database yang boleh diotak-atik.
require("dotenv").config();
const {
  query,
  closeDb,
  saveMemory,
  getHistory,
  getHistoryForAI,
  getReplyContext,
  getChatState,
  updateChatSummary,
  newTopic,
  getBotConfig,
  saveBotConfig,
  resetBotConfig,
  getUserAccess,
  setUserAccess,
  deleteUserAccess,
  setChatPaused,
  isChatPaused
} = require("./dbHelper.js");

const chatId = -1009990000000 - Math.floor(Math.random() * 1e6); // mirip id grup Telegram
const otherChat = chatId - 1;
let ok = 0, bad = 0;

function check(name, cond) {
  cond ? ok++ : bad++;
  console.log(`${cond ? "✅" : "❌"} ${name}`);
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL belum diisi di .env (contoh: postgres://user:pass@localhost:5432/nroz)");
    process.exit(1);
  }

  console.log("Tes PostgreSQL...\n");
  try {
    await saveMemory(chatId, "user", "halo", 1001);
    await saveMemory(chatId, "assistant", "hai juga", 1002);
    await saveMemory(chatId, "user", "[Kirim Foto]: tanpa message id");
    await saveMemory(otherChat, "user", "chat lain");

    let h = await getHistory(chatId);
    check("simpan + getHistory (3 pesan, chat lain gak ikut)", h.length === 3);
    check("urutan lama → baru, role benar",
      h[0].content === "halo" && h[1].role === "assistant" && h[2].content.startsWith("[Kirim Foto]"));

    const ctx = await getReplyContext(chatId, 1002);
    check("getReplyContext nemu pesan yang direply", !!ctx && ctx.content === "hai juga");
    check("getReplyContext null kalau pesan gak ada", (await getReplyContext(chatId, 9999)) === null);

    const bigText = "x".repeat(1_500_000);
    await saveMemory(chatId, "user", bigText, 1004);
    const bigCtx = await getReplyContext(chatId, 1004);
    check("teks > 1MB tersimpan utuh (tak ada lagi batas dokumen)", !!bigCtx && bigCtx.content.length === bigText.length);

    const { purge } = await newTopic(chatId);
    h = await getHistory(chatId);
    check("setelah /newtopic history kosong", h.length === 0);
    check("reply ke pesan topic lama → null", (await getReplyContext(chatId, 1002)) === null);

    await saveMemory(chatId, "user", "topik baru", 1005);
    h = await getHistory(chatId);
    check("pesan baru muncul di topic baru", h.length === 1 && h[0].content === "topik baru");

    await purge; // di PostgreSQL penghapusan sudah selesai; ini cuma menjaga bentuk interface
    const leftover = await query("SELECT id FROM chat_memory WHERE chat_id = $1 AND ts <= $2", [String(chatId), (await getChatState(chatId)).topic_ts]);
    check("pesan lama benar-benar terhapus dari database", leftover.rowCount === 0);
    check("chat lain tetap aman", (await getHistory(otherChat)).length === 1);

    // Tes fitur konfigurasi bot dinamis
    console.log("\nTes Pengaturan Bot Dinamis...");
    await saveBotConfig({ model: "test-model-123", baseUrl: "https://test.api", apiKey: "test-key-xyz" });
    const cfg = await getBotConfig();
    check("saveBotConfig & getBotConfig berhasil", cfg && cfg.model === "test-model-123" && cfg.apiKey === "test-key-xyz");

    await resetBotConfig();
    const cfgReset = await getBotConfig();
    check("resetBotConfig berhasil menghapus config", cfgReset === null);

    // Tes Summary Buffer Memory
    console.log("\nTes Summary Buffer Memory...");
    await updateChatSummary(chatId, "User suka ngoding Node.js", Date.now() * 1000 + 1000);
    const aiHistory = await getHistoryForAI(chatId, 6);
    check("getHistoryForAI menyertakan system prompt summary", aiHistory.length === 2 && aiHistory[0].role === "system" && aiHistory[0].content.includes("User suka ngoding"));
    check("getHistoryForAI menyertakan pesan terbaru", aiHistory[1].role === "user" && aiHistory[1].content === "topik baru");

    // Tes Sistem Akses User (Approval)
    console.log("\nTes Sistem Akses Pengguna (Approval)...");
    const testUserId = "9988776655";
    await setUserAccess(testUserId, "pending", { name: "Budi Test", username: "@buditest" });
    let uAccess = await getUserAccess(testUserId);
    check("setUserAccess & getUserAccess status pending", uAccess && uAccess.status === "pending" && uAccess.name === "Budi Test");

    await setUserAccess(testUserId, "approved");
    uAccess = await getUserAccess(testUserId);
    check("setUserAccess update ke approved", uAccess && uAccess.status === "approved");

    await deleteUserAccess(testUserId);
    uAccess = await getUserAccess(testUserId);
    check("deleteUserAccess berhasil menghapus data", uAccess === null);

    // Tes Pause & Resume
    console.log("\nTes Pause & Resume Topik/Chat...");
    check("status awal tidak paused", (await isChatPaused(chatId)) === false);
    await setChatPaused(chatId, true);
    check("setChatPaused(true) berhasil", (await isChatPaused(chatId)) === true);
    await setChatPaused(chatId, false);
    check("setChatPaused(false) berhasil", (await isChatPaused(chatId)) === false);
  } catch (err) {
    bad++;
    console.error("❌ Error:", err.message);
    console.error("   Cek DATABASE_URL di .env dan koneksi ke PostgreSQL");
  } finally {
    // bersihin semua data tes
    try { await query("DELETE FROM chat_memory WHERE chat_id = ANY($1)", [[String(chatId), String(otherChat)]]); } catch {}
    try { await query("DELETE FROM chat_state WHERE id = ANY($1)", [[String(chatId), String(otherChat)]]); } catch {}
    try { await deleteUserAccess("9988776655"); } catch {}
    try { await resetBotConfig(); } catch {}
    await closeDb();
    console.log(`\nHasil: ${ok} lolos, ${bad} gagal`);
    process.exit(bad ? 1 : 0);
  }
})();
