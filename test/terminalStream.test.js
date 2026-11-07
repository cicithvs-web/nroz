const test = require("node:test");
const assert = require("node:assert/strict");

const {
  stripAnsi,
  sanitizeTerminalText,
  formatTerminalMessage,
  parseExitContent
} = require("../bot/terminalStream");

test("stripAnsi: buang warna/kursor, sisakan teks polos", () => {
  assert.equal(stripAnsi("\x1B[32mGet:2 paket\x1B[0m ok"), "Get:2 paket ok");
  assert.equal(stripAnsi("a\x1B[1;31mb\x1B[Kc"), "abc");
  assert.equal(stripAnsi("tanpa escape"), "tanpa escape");
});

test("sanitizeTerminalText: lipat progress-bar \\r per baris", () => {
  const input = "Baris satu\r0%\r50%\r100%\nBaris dua";
  assert.equal(sanitizeTerminalText(input), "100%\nBaris dua");
});

test("sanitizeTerminalText: backtick dinetralkan agar code block utuh", () => {
  assert.ok(!sanitizeTerminalText("echo ```bash```").includes("```"));
});

test("sanitizeTerminalText: ekor dipertahankan saat melebihi batas", () => {
  const out = sanitizeTerminalText("x".repeat(5000) + "EKOR-PENTING", 1000);
  assert.ok(out.length <= 1100);
  assert.ok(out.endsWith("EKOR-PENTING"));
  assert.ok(out.startsWith("…"));
});

test("formatTerminalMessage: status berjalan vs selesai", () => {
  const run = formatTerminalMessage({
    jobId: "bg7",
    command: "apt-get install -y ffmpeg",
    elapsedSec: 34.2,
    tail: "Setting up ffmpeg ...",
    state: "running"
  });
  assert.ok(run.includes("⏳ Terminal — bg7 · apt-get install -y ffmpeg"));
  assert.ok(run.includes("berjalan 34s"));
  assert.ok(run.includes("```\nSetting up ffmpeg ...\n```"));

  const done = formatTerminalMessage({
    jobId: "bg7",
    command: "apt-get install -y ffmpeg",
    elapsedSec: 41,
    tail: "",
    state: "ok",
    exitCode: 0
  });
  assert.ok(done.includes("✅ Terminal — bg7"));
  assert.ok(done.includes("exit 0"));
  assert.ok(!done.includes("```"));

  const gagal = formatTerminalMessage({ jobId: "bg2", command: "x", elapsedSec: 3, tail: "err", state: "failed", exitCode: 1 });
  assert.ok(gagal.includes("❌ Terminal — bg2"));
  assert.ok(gagal.includes("exit 1"));
});

test("parseExitContent: isi file .exit -> angka atau null", () => {
  assert.equal(parseExitContent("0\n"), 0);
  assert.equal(parseExitContent("  127  "), 127);
  assert.equal(parseExitContent(""), null);
  assert.equal(parseExitContent("buat-bukan-angka"), null);
});
