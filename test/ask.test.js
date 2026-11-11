/**
 * test/ask.test.js — ask_user: hanya pesan TEKS yang boleh menjawab pertanyaan tertunda.
 *
 * Regresi yang dijaga: bot.on("message") di bot/handlers.js juga menyala untuk
 * foto/video/dokumen (yang tidak punya .text). Dulu takePendingAskAnswer dipanggil
 * sebelum penjagaan `if (!msg.text) return;`, sehingga mengirim video referensi saat
 * agent sedang bertanya akan menutup pertanyaan itu dengan jawaban kosong.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const ctx = require("../bot/context");
ctx.bot = {
  sendMessage: async () => ({ message_id: 1, chat: { id: 1 } }),
  editMessageText: async () => ({}),
  editMessageReplyMarkup: async () => ({})
};

const { toolAskUser, takePendingAskAnswer, takePendingAskMedia, pendingAskCount, _resetForTests } = require("../tools/ask");

/** Jeda singkat agar entry pertanyaan selesai terdaftar. */
const settle = () => new Promise((r) => setTimeout(r, 50));

test("kiriman media (tanpa .text) tidak menjawab pertanyaan tertunda", async () => {
  _resetForTests();
  const sessionId = "ask-media";
  // JANGAN di-await: promise ini baru selesai setelah user menjawab.
  const answer = toolAskUser({ question: "Durasi videonya berapa detik?", options: ["15", "30"], sessionId, chatId: 1 });
  await settle();
  assert.equal(pendingAskCount(sessionId), 1);

  const videoMsg = { chat: { id: 1, type: "private" }, video: { file_id: "x" }, caption: "bikin kayak gini" };
  assert.equal(takePendingAskAnswer(sessionId, videoMsg.text), false);
  assert.equal(takePendingAskAnswer(sessionId, undefined), false);
  assert.equal(takePendingAskAnswer(sessionId, null), false);
  assert.equal(takePendingAskAnswer(sessionId, "   "), false);
  assert.equal(pendingAskCount(sessionId), 1, "pertanyaan harus masih menunggu");

  // Jawaban teks asli tetap diterima.
  assert.equal(takePendingAskAnswer(sessionId, "30 detik"), true);
  assert.match(await answer, /30 detik/);
  assert.equal(pendingAskCount(sessionId), 0);
});

test("tanpa pertanyaan tertunda, jawaban teks tidak diintersep", () => {
  _resetForTests();
  assert.equal(takePendingAskAnswer("ask-kosong", "halo"), false);
});

test("takePendingAskMedia menangkap foto/dokumen saat ask_user sedang menunggu", async () => {
  _resetForTests();
  const sessionId = "ask-upload";
  const answer = toolAskUser({ question: "Silakan kirim foto KTP/logo untuk di-upload:", sessionId, chatId: 1 });
  await settle();
  assert.equal(pendingAskCount(sessionId), 1);

  const intercepted = takePendingAskMedia(sessionId, {
    type: "photo",
    fileName: "photo_123.jpg",
    savedFilePath: "/opt/nroz/workspace/ask-upload/uploads/photo_123.jpg",
    sandboxPath: "/workspace/uploads/photo_123.jpg",
    caption: "ini logonya"
  });
  assert.equal(intercepted, true);
  assert.equal(pendingAskCount(sessionId), 0);
  const resText = await answer;
  assert.match(resText, /photo_123\.jpg/);
  assert.match(resText, /\/workspace\/uploads\/photo_123\.jpg/);
  assert.match(resText, /ini logonya/);
});

test("takePendingAskMedia menangkap batch banyak foto/file sekaligus saat ask_user sedang menunggu", async () => {
  _resetForTests();
  const sessionId = "ask-multi-upload";
  const answer = toolAskUser({ question: "Kirim 3 foto produk:", sessionId, chatId: 1 });
  await settle();
  assert.equal(pendingAskCount(sessionId), 1);

  const intercepted = takePendingAskMedia(sessionId, [
    {
      type: "photo",
      fileName: "photo_1.jpg",
      savedFilePath: "/opt/nroz/workspace/ask-multi-upload/uploads/photo_1.jpg",
      sandboxPath: "/workspace/uploads/photo_1.jpg",
      caption: "tampak depan dan samping"
    },
    {
      type: "photo",
      fileName: "photo_2.jpg",
      savedFilePath: "/opt/nroz/workspace/ask-multi-upload/uploads/photo_2.jpg",
      sandboxPath: "/workspace/uploads/photo_2.jpg",
      caption: ""
    },
    {
      type: "photo",
      fileName: "photo_3.jpg",
      savedFilePath: "/opt/nroz/workspace/ask-multi-upload/uploads/photo_3.jpg",
      sandboxPath: "/workspace/uploads/photo_3.jpg",
      caption: ""
    }
  ]);
  assert.equal(intercepted, true);
  assert.equal(pendingAskCount(sessionId), 0);
  const resText = await answer;
  assert.match(resText, /3 file sekaligus/);
  assert.match(resText, /photo_1\.jpg/);
  assert.match(resText, /photo_2\.jpg/);
  assert.match(resText, /photo_3\.jpg/);
  assert.match(resText, /tampak depan dan samping/);
});
