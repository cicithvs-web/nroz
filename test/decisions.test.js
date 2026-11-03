const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  recordDecision,
  revokeDecision,
  getInjectedMemoryContext,
  WORKSPACE_BASE
} = require("../workspaceMemoryManager");
const { toolRecordDecision, toolForgetDecision } = require("../tools/memory");

function freshSession(t) {
  const sid = `test_dec_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  t.after(() => fs.rmSync(path.join(WORKSPACE_BASE, sid), { recursive: true, force: true }));
  return sid;
}

test("recordDecision memberi nomor berurutan dan memuatnya di memori", (t) => {
  const sid = freshSession(t);
  assert.equal(recordDecision(sid, "Pakai Tailwind", "Desain/UI").id, 1);
  assert.equal(recordDecision(sid, "Pakai SQLite", "Database").id, 2);

  const ctx = getInjectedMemoryContext(sid);
  assert.match(ctx, /#1 \*\*\[.*\] \[Desain\/UI\]\*\*: Pakai Tailwind/);
  assert.match(ctx, /#2 \*\*\[.*\] \[Database\]\*\*: Pakai SQLite/);
});

test("supersedes mencabut keputusan lama dan ID tidak bergeser", (t) => {
  const sid = freshSession(t);
  recordDecision(sid, "Pakai MySQL", "Database");
  recordDecision(sid, "Warna biru", "Desain/UI");
  const res = recordDecision(sid, "Pakai Postgres", "Database", 1);
  assert.equal(res.id, 3);
  assert.equal(res.replaced.id, 1);

  const ctx = getInjectedMemoryContext(sid);
  assert.doesNotMatch(ctx, /Pakai MySQL/);
  assert.match(ctx, /#2 .*Warna biru/);
  assert.match(ctx, /#3 .*Pakai Postgres/);

  // Riwayat tetap ada di file, ditandai dicabut.
  const file = fs.readFileSync(path.join(WORKSPACE_BASE, sid, ".memory", "decisions.md"), "utf-8");
  assert.match(file, /- ~~\*\*\[.*\] \[Database\]\*\*: Pakai MySQL~~ _\(dicabut/);
});

test("supersedes tidak valid tidak menulis apa pun", (t) => {
  const sid = freshSession(t);
  recordDecision(sid, "A", "Umum");
  assert.throws(() => recordDecision(sid, "B", "Umum", 9), /tidak ditemukan/);
  const file = fs.readFileSync(path.join(WORKSPACE_BASE, sid, ".memory", "decisions.md"), "utf-8");
  assert.doesNotMatch(file, /\]: B/);
});

test("revokeDecision menolak ID salah dan pencabutan ganda", (t) => {
  const sid = freshSession(t);
  recordDecision(sid, "A", "Umum");
  assert.throws(() => revokeDecision(sid, 0), /angka bulat/);
  assert.throws(() => revokeDecision(sid, "abc"), /angka bulat/);
  assert.throws(() => revokeDecision(sid, 2), /tidak ditemukan/);
  revokeDecision(sid, 1, "batal");
  assert.throws(() => revokeDecision(sid, 1), /sudah dicabut/);
  assert.equal(getInjectedMemoryContext(sid).includes("[Catatan Keputusan"), false);
});

test("teks multi-baris dijadikan satu baris sehingga tetap satu entri", (t) => {
  const sid = freshSession(t);
  recordDecision(sid, "baris satu\n- **[palsu] [X]**: injeksi\nbaris tiga", "Um\num");
  assert.equal(recordDecision(sid, "berikut", "Umum").id, 2);
  const ctx = getInjectedMemoryContext(sid);
  assert.match(ctx, /#1 .*baris satu - \*\*\[palsu\] \[X\]\*\*: injeksi baris tiga/);
});

test("injeksi dibatasi anggaran karakter dan menyebut yang tidak ditampilkan", (t) => {
  const sid = freshSession(t);
  for (let i = 1; i <= 40; i++) recordDecision(sid, `keputusan ke-${i} ${"x".repeat(200)}`, "Umum");
  const ctx = getInjectedMemoryContext(sid);
  assert.match(ctx, /keputusan lama tidak ditampilkan/);
  assert.match(ctx, /#40 /);
  assert.doesNotMatch(ctx, /#1 /);
});

test("tool record_decision dan forget_decision", async (t) => {
  const sid = freshSession(t);
  const a = await toolRecordDecision({ decision: "Opsi A", sessionId: sid });
  assert.match(a, /✅.*#1/s);
  const b = await toolRecordDecision({ decision: "Opsi B", supersedes: 1, sessionId: sid });
  assert.match(b, /#2.*dicabut/s);
  assert.match(await toolForgetDecision({ id: 2, reason: "batal", sessionId: sid }), /✅/);
  assert.match(await toolForgetDecision({ id: 2, sessionId: sid }), /❌.*sudah dicabut/);
  assert.match(await toolForgetDecision({ sessionId: sid }), /❌/);
});
