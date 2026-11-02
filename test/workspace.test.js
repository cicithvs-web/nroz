const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cleanupOldWorkspaceFiles, PROTECTED_ENTRIES } = require("../bot/workspace");
const {
  saveTurnCheckpoint,
  loadTurnCheckpoint,
  clearTurnCheckpoint,
  formatTurnCheckpoint,
  ensureWorkspaceStructure,
  WORKSPACE_BASE
} = require("../workspaceMemoryManager");

test("auto-cleanup tidak menghapus .memory, skills, work, uploads", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nroz-clean-"));
  const ws = path.join(base, "123");
  for (const d of [".memory", "skills", "work", "uploads", "artifacts", ".bg"]) {
    fs.mkdirSync(path.join(ws, d), { recursive: true });
    fs.writeFileSync(path.join(ws, d, "f.txt"), "12345");
  }
  fs.writeFileSync(path.join(ws, "video.mp4"), "x".repeat(1000));

  const old = (Date.now() - 10 * 86400_000) / 1000;
  for (const name of fs.readdirSync(ws)) fs.utimesSync(path.join(ws, name), old, old);

  const res = cleanupOldWorkspaceFiles(3, { base });
  assert.deepEqual(fs.readdirSync(ws).sort(), [...PROTECTED_ENTRIES].sort());
  assert.equal(res.deletedCount, 3);
  assert.ok(res.freedBytes >= 1010, `freedBytes ${res.freedBytes}`);
  assert.equal(fs.readFileSync(path.join(ws, ".memory", "f.txt"), "utf-8"), "12345");
});

test("auto-cleanup membiarkan item yang masih baru", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nroz-clean-"));
  fs.mkdirSync(path.join(base, "u", "artifacts"), { recursive: true });
  assert.equal(cleanupOldWorkspaceFiles(3, { base }).deletedCount, 0);
  assert.ok(fs.existsSync(path.join(base, "u", "artifacts")));
});

test("checkpoint giliran tersimpan, terformat, dan bisa dihapus", () => {
  const sid = `test_cp_${process.pid}_${Date.now()}`;
  try {
    assert.equal(loadTurnCheckpoint(sid), null);
    saveTurnCheckpoint(sid, {
      status: "limit",
      userRequest: "buat landing page",
      steps: [
        { n: 1, desc: "menulis index.html (300 byte)", ok: true, result: "Berhasil menulis /workspace/work/index.html" },
        { n: 2, desc: "menjalankan `npm test`", ok: false, result: "Perintah gagal (exit code 1)" }
      ],
      lastAssistantNote: "Tinggal perbaiki test."
    });
    const cp = loadTurnCheckpoint(sid);
    assert.equal(cp.status, "limit");
    const text = formatTurnCheckpoint(cp);
    assert.match(text, /batas langkah/);
    assert.match(text, /1\. ✅ menulis index\.html/);
    assert.match(text, /2\. ❌ menjalankan `npm test`/);
    assert.match(text, /Tinggal perbaiki test/);

    clearTurnCheckpoint(sid);
    assert.equal(loadTurnCheckpoint(sid), null);
  } finally {
    fs.rmSync(path.join(WORKSPACE_BASE, sid), { recursive: true, force: true });
  }
});

test("ensureWorkspaceStructure mengganti symlink folder yang keluar dari workspace", () => {
  const sid = `test_link_${process.pid}_${Date.now()}`;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nroz-outside-"));
  const ws = path.join(WORKSPACE_BASE, sid);
  try {
    fs.mkdirSync(ws, { recursive: true });
    fs.symlinkSync(outside, path.join(ws, "uploads"));
    const res = ensureWorkspaceStructure(sid);
    assert.equal(fs.lstatSync(res.uploadsDir).isSymbolicLink(), false);
    assert.ok(fs.existsSync(outside), "target symlink tidak ikut dihapus");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
