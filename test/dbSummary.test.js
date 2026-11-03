const test = require("node:test");
const assert = require("node:assert/strict");

const { updateChatSummary, getChatState, __setQueryForTests } = require("../dbHelper");

/**
 * PostgreSQL palsu di memori yang meniru perilaku SQL dbHelper untuk chat_state:
 * - SELECT * FROM chat_state WHERE id = $1
 * - INSERT ... ON CONFLICT DO UPDATE ... WHERE topic_ts <= upToTs RETURNING
 */
function stubDb(t, { state, echoUpToTs, failWrite } = {}) {
  let stored = state || null;
  const writes = [];

  __setQueryForTests(async (text, params) => {
    if (/^\s*SELECT \* FROM chat_state/.test(text)) {
      return { rows: stored ? [stored] : [], rowCount: stored ? 1 : 0 };
    }
    if (/INSERT INTO chat_state/.test(text)) {
      if (failWrite) throw new Error("boom");
      const [, summary, upToTs] = params;
      writes.push({ summary, upToTs });

      // Server "menerima" tapi tidak menyimpan nilai baru (skenario konfirmasi gagal)
      if (echoUpToTs !== undefined) {
        return { rows: [{ summarized_up_to_ts: echoUpToTs }], rowCount: 1 };
      }
      // WHERE chat_state.topic_ts <= upToTs: konflik di-skip jika topik lebih baru
      if (stored && Number(stored.topic_ts) > Number(upToTs)) {
        return { rows: [], rowCount: 0 };
      }
      stored = {
        topic_ts: stored ? Number(stored.topic_ts) : 0,
        summary,
        summarized_up_to_ts: Number(upToTs),
        is_paused: stored ? stored.is_paused : false
      };
      return { rows: [{ summarized_up_to_ts: upToTs }], rowCount: 1 };
    }
    throw new Error("query tak dikenal: " + text);
  });
  t.after(() => __setQueryForTests(null));
  return writes;
}

let n = 0;
const newChatId = () => `unit_${process.pid}_${++n}`;

test("updateChatSummary: tersimpan dan state ikut diperbarui", async (t) => {
  const chat = newChatId();
  const writes = stubDb(t, { state: { topic_ts: 100, summary: "", summarized_up_to_ts: 100, is_paused: false } });
  const res = await updateChatSummary(chat, "ringkasan baru", 500);
  assert.deepEqual(res, { saved: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].upToTs, 500);
  const state = await getChatState(chat);
  assert.equal(state.summary, "ringkasan baru");
  assert.equal(state.summarized_up_to_ts, 500);
});

test("updateChatSummary: dilewati dengan alasan jika topik baru lebih baru", async (t) => {
  const chat = newChatId();
  stubDb(t, { state: { topic_ts: 900, summary: "", summarized_up_to_ts: 900, is_paused: false } });
  const res = await updateChatSummary(chat, "x", 500);
  assert.equal(res.saved, false);
  assert.match(res.reason, /topik baru/);
  // State di DB tidak berubah
  const state = await getChatState(chat);
  assert.equal(state.summarized_up_to_ts, 900);
  assert.equal(state.summary, "");
});

test("updateChatSummary: respons yang tidak mengonfirmasi dianggap gagal", async (t) => {
  const chat = newChatId();
  stubDb(t, {
    state: { topic_ts: 0, summary: "lama", summarized_up_to_ts: 0, is_paused: false },
    echoUpToTs: 0 // server mengembalikan nilai yang tidak sesuai tulisan
  });
  const res = await updateChatSummary(chat, "baru", 500);
  assert.equal(res.saved, false);
  assert.match(res.reason, /tidak mengonfirmasi/);
  // Nilai di DB tetap yang lama
  assert.equal((await getChatState(chat)).summary, "lama");
});

test("updateChatSummary: error database dilempar dan state tidak berubah", async (t) => {
  const chat = newChatId();
  stubDb(t, {
    state: { topic_ts: 0, summary: "lama", summarized_up_to_ts: 0, is_paused: false },
    failWrite: true
  });
  await assert.rejects(() => updateChatSummary(chat, "baru", 500), /boom/);
  assert.equal((await getChatState(chat)).summary, "lama");
});
