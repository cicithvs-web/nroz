const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { recordDecision, listActiveDecisions, getInjectedMemoryContext, WORKSPACE_BASE } = require("../workspaceMemoryManager");
const {
  DECISIONS_MARKER,
  buildDecisionExtractionPrompt,
  parseCompactionOutput,
  applyAutoDecisions
} = require("../bot/autoMemory");

function freshSession(t) {
  const sid = `test_auto_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  t.after(() => fs.rmSync(path.join(WORKSPACE_BASE, sid), { recursive: true, force: true }));
  return sid;
}

test("parseCompactionOutput memisahkan ringkasan dan keputusan", () => {
  const out = [
    "Profil & preferensi user:",
    "- Suka jawaban singkat",
    "",
    DECISIONS_MARKER,
    "- [Database] Pakai SQLite untuk proyek ini",
    "- GANTI #2 [Desain/UI] Warna utama diganti hijau",
    "- tanpa kategori tapi cukup panjang"
  ].join("\n");
  const { summary, decisions } = parseCompactionOutput(out);
  assert.equal(summary, "Profil & preferensi user:\n- Suka jawaban singkat");
  assert.deepEqual(decisions, [
    { supersedes: null, category: "Database", text: "Pakai SQLite untuk proyek ini" },
    { supersedes: 2, category: "Desain/UI", text: "Warna utama diganti hijau" },
    { supersedes: null, category: "Umum", text: "tanpa kategori tapi cukup panjang" }
  ]);
});

test("parseCompactionOutput: tanpa penanda semua jadi ringkasan; 'tidak ada' diabaikan", () => {
  assert.deepEqual(parseCompactionOutput("hanya ringkasan"), { summary: "hanya ringkasan", decisions: [] });
  const r = parseCompactionOutput(`ringkasan\n${DECISIONS_MARKER}\n- tidak ada`);
  assert.equal(r.summary, "ringkasan");
  assert.deepEqual(r.decisions, []);
  assert.deepEqual(parseCompactionOutput(null), { summary: "", decisions: [] });
});

test("parseCompactionOutput membatasi jumlah dan panjang", () => {
  const lines = Array.from({ length: 9 }, (_, i) => `- [K] keputusan nomor ${i} ${"y".repeat(500)}`);
  const { decisions } = parseCompactionOutput(`s\n${DECISIONS_MARKER}\n${lines.join("\n")}`);
  assert.equal(decisions.length, 5);
  assert.ok(decisions.every((d) => d.text.length <= 300));
});

test("applyAutoDecisions menulis dengan label Otomatis dan melewati duplikat", (t) => {
  const sid = freshSession(t);
  recordDecision(sid, "Pakai SQLite untuk proyek ini", "Database");
  const written = applyAutoDecisions(sid, [
    { supersedes: null, category: "Database", text: "pakai sqlite untuk proyek ini!" }, // duplikat
    { supersedes: null, category: "Bahasa", text: "User minta jawaban selalu singkat" },
    { supersedes: null, category: "Bahasa", text: "User minta jawaban selalu singkat" } // duplikat dalam batch
  ]);
  assert.equal(written, 1);
  const active = listActiveDecisions(sid);
  assert.equal(active.length, 2);
  assert.equal(active[1].category, "Otomatis · Bahasa");
});

test("applyAutoDecisions: GANTI mencabut yang lama, nomor tidak valid hanya mencatat baru", (t) => {
  const sid = freshSession(t);
  recordDecision(sid, "Warna utama biru", "Desain/UI");
  assert.equal(applyAutoDecisions(sid, [{ supersedes: 1, category: "Desain/UI", text: "Warna utama diganti hijau" }]), 1);
  assert.equal(applyAutoDecisions(sid, [{ supersedes: 99, category: "Umum", text: "Gunakan font Inter di semua halaman" }]), 1);

  const ctx = getInjectedMemoryContext(sid);
  assert.doesNotMatch(ctx, /Warna utama biru/);
  assert.match(ctx, /#2 .*Warna utama diganti hijau/);
  assert.match(ctx, /#3 .*font Inter/);
});

test("buildDecisionExtractionPrompt memuat penanda dan daftar keputusan aktif", (t) => {
  const sid = freshSession(t);
  recordDecision(sid, "Pakai Tailwind", "Desain/UI");
  const p = buildDecisionExtractionPrompt(listActiveDecisions(sid));
  assert.ok(p.includes(DECISIONS_MARKER));
  assert.match(p, /#1 \[Desain\/UI\] Pakai Tailwind/);
  assert.match(buildDecisionExtractionPrompt([]), /\(belum ada\)/);
});
