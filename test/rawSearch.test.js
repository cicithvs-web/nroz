const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ensureWorkspaceStructure, searchRawMemory, WORKSPACE_BASE } = require("../workspaceMemoryManager");
const { toolSearchRawMemory } = require("../tools/memory");

function freshSession(t) {
  const sid = `test_raw_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  t.after(() => fs.rmSync(path.join(WORKSPACE_BASE, sid), { recursive: true, force: true }));
  return sid;
}

/** Menulis arsip: entries = [{ day: "2026-10-01", role, content }]. */
function seed(sid, entries) {
  const { rawDir } = ensureWorkspaceStructure(sid);
  const byDay = {};
  for (const e of entries) {
    (byDay[e.day] ||= []).push(JSON.stringify({ timestamp: `${e.day}T10:00:00.000Z`, role: e.role || "user", content: e.content }));
  }
  for (const [day, lines] of Object.entries(byDay)) {
    fs.writeFileSync(path.join(rawDir, `chat_${day}.jsonl`), lines.join("\n") + "\n");
  }
}

test("query multi-kata cocok walau kata tidak berurutan", (t) => {
  const sid = freshSession(t);
  seed(sid, [{ day: "2026-10-01", content: "Kita pakai tailwind karena alasan ukuran bundle kecil" }]);
  const res = searchRawMemory(sid, "alasan pakai tailwind");
  assert.equal(res.length, 1);
});

test("kata umum (stopword) tidak dihitung dan tidak membuat query gagal", (t) => {
  const sid = freshSession(t);
  seed(sid, [{ day: "2026-10-01", content: "Database yang dipilih adalah SQLite" }]);
  assert.equal(searchRawMemory(sid, "apa yang kita pilih untuk database").length, 1);
});

test("pesan yang hanya cocok sedikit kata disaring", (t) => {
  const sid = freshSession(t);
  seed(sid, [
    { day: "2026-10-01", content: "deploy ke server produksi lewat docker compose" },
    { day: "2026-10-02", content: "cuma bahas docker saja" }
  ]);
  const res = searchRawMemory(sid, "deploy server docker produksi");
  assert.equal(res.length, 1);
  assert.match(res[0].content, /deploy ke server/);
});

test("hasil diurutkan menurut relevansi, bukan sekadar yang terbaru", (t) => {
  const sid = freshSession(t);
  seed(sid, [
    { day: "2026-09-01", content: "Keputusan database: pakai sqlite karena ringan" },
    { day: "2026-10-30", content: "oke database nanti saja" }
  ]);
  const res = searchRawMemory(sid, "database sqlite");
  assert.equal(res.length, 2);
  assert.match(res[0].content, /sqlite karena ringan/);
});

test("bonus frasa utuh dan bonus recency saat skor kata sama", (t) => {
  const sid = freshSession(t);
  seed(sid, [
    { day: "2026-08-01", content: "port server 3000" },
    { day: "2026-10-30", content: "server port 3000" }
  ]);
  const res = searchRawMemory(sid, "port server");
  assert.match(res[0].content, /^port server/); // frasa utuh menang atas yang lebih baru
  const res2 = searchRawMemory(sid, "server 3000 port");
  assert.equal(res2[0].timestamp.slice(0, 10), "2026-10-30"); // tanpa frasa utuh, yang baru menang
});

test("cuplikan berpusat di sekitar kata yang cocok pada pesan panjang", (t) => {
  const sid = freshSession(t);
  const long = "awal ".repeat(300) + "KUNCI_RAHASIA ada di sini " + "akhir ".repeat(300);
  seed(sid, [{ day: "2026-10-01", content: long }]);
  const [r] = searchRawMemory(sid, "kunci_rahasia");
  assert.match(r.content, /kunci_rahasia/i);
  assert.ok(r.content.length <= 602 + 2);
});

test("limit dihormati dan dibatasi maksimal; query kosong/kata pendek tidak error", (t) => {
  const sid = freshSession(t);
  const entries = Array.from({ length: 30 }, (_, i) => ({
    day: `2026-10-${String(i + 1).padStart(2, "0")}`,
    content: `catatan deploy nomor ${i}`
  }));
  seed(sid, entries);
  assert.equal(searchRawMemory(sid, "deploy", 3).length, 3);
  assert.equal(searchRawMemory(sid, "deploy", 999).length, 20);
  assert.deepEqual(searchRawMemory(sid, "   "), []);
  assert.deepEqual(searchRawMemory(sid, "a"), []);
  assert.deepEqual(searchRawMemory(sid, undefined), []);
});

test("baris rusak dan entri tanpa content dilewati", (t) => {
  const sid = freshSession(t);
  const { rawDir } = ensureWorkspaceStructure(sid);
  fs.writeFileSync(
    path.join(rawDir, "chat_2026-10-01.jsonl"),
    ["{rusak deploy", JSON.stringify({ timestamp: "2026-10-01T00:00:00Z", role: "user" }),
      JSON.stringify({ timestamp: "2026-10-01T00:00:00Z", role: "user", content: "deploy sukses" })].join("\n")
  );
  const res = searchRawMemory(sid, "deploy");
  assert.equal(res.length, 1);
  assert.equal(res[0].content, "deploy sukses");
});

test("tool search_raw_memory memformat hasil dan pesan kosong", async (t) => {
  const sid = freshSession(t);
  seed(sid, [{ day: "2026-10-01", content: "pakai sqlite", role: "assistant" }]);
  assert.match(await toolSearchRawMemory({ query: "sqlite", sessionId: sid }), /Ditemukan 1.*ASSISTANT.*pakai sqlite/s);
  assert.match(await toolSearchRawMemory({ query: "tidakada", sessionId: sid }), /Tidak ditemukan/);
  assert.match(await toolSearchRawMemory({ sessionId: sid }), /❌/);
});
