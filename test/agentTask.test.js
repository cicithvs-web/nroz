const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Arahkan scheduler ke file sementara SEBELUM modul dimuat (pola sama dengan scheduler.test.js).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nroz-agttask-"));
process.env.SCHEDULER_DATA_FILE = path.join(tmpDir, "scheduler_data.json");
const s = require("../schedulerManager");

const TZ = "Asia/Jakarta";
const wib = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 7, mi); // WIB = UTC+7

test("addAgentTask: menyimpan tugas dengan metadata lengkap", () => {
  const target = wib(2026, 11, 7, 7, 0);
  const t = s.addAgentTask({
    sessionId: "12345",
    chatId: "12345",
    task: "Cek harga emas dan laporkan",
    targetTime: target,
    repeat: "daily",
    timezone: TZ
  });

  assert.match(t.id, /^agt_/);
  assert.equal(t.task, "Cek harga emas dan laporkan");
  assert.equal(t.targetTime, target);
  assert.equal(t.repeat, "daily");
  assert.equal(t.timezone, TZ);
  assert.equal(t.anchorDay, null); // anchorDay hanya diisi untuk repeat monthly

  const tMonthly = s.addAgentTask({
    sessionId: "12345",
    chatId: "12345",
    task: "backup bulanan",
    targetTime: wib(2026, 12, 31, 9, 0),
    repeat: "monthly",
    timezone: TZ
  });
  assert.equal(tMonthly.anchorDay, 31); // tanggal anchor untuk bulan pendek

  const { agentTasks } = s.listTasks("12345");
  assert.equal(agentTasks.length, 2); // t harian + tMonthly
  assert.equal(s.getTask(t.id).id, t.id);
});

test("addAgentTask: validasi input", () => {
  assert.throws(() => s.addAgentTask({ sessionId: "1", task: "   ", targetTime: Date.now() + 1000 }), /tidak boleh kosong/);
  assert.throws(() => s.addAgentTask({ sessionId: "1", task: "x", targetTime: Date.now() + 1000, repeat: "tahunan" }), /repeat harus/);
  assert.throws(
    () => s.addAgentTask({ sessionId: "1", task: "x", targetTime: Date.now() + 1000, timezone: "Mars/Jakarta" }),
    /Zona waktu/
  );
});

test("addAgentTask: batas jumlah per sesi", () => {
  const sid = "limit-test";
  for (let i = 0; i < 20; i++) {
    s.addAgentTask({ sessionId: sid, task: `tugas ${i}`, targetTime: Date.now() + 60_000 * (i + 1) });
  }
  assert.throws(() => s.addAgentTask({ sessionId: sid, task: "ke-21", targetTime: Date.now() + 60_000 }), /Batas 20/);
});

test("removeTask menghapus tugas agent milik sesi itu saja", () => {
  const t1 = s.addAgentTask({ sessionId: "satu", task: "milik satu", targetTime: Date.now() + 60_000 });
  const t2 = s.addAgentTask({ sessionId: "dua", task: "milik dua", targetTime: Date.now() + 60_000 });

  assert.equal(s.removeTask("satu", t2.id), false); // id milik sesi lain
  assert.equal(s.removeTask("satu", t1.id), true);
  assert.equal(s.getTask(t1.id), null);
  assert.notEqual(s.getTask(t2.id), null);
  s.removeTask("dua", t2.id);
});

test("checkAgentTasks tidak jalan tanpa bot instance dan tidak melempar", async () => {
  const before = s.listTasks("never-fired").agentTasks.length;
  await s.checkAgentTasks(Date.now());
  const after = s.listTasks("never-fired").agentTasks.length;
  assert.equal(before, after);
});

test("tugas agent persisten ke file (load ulang)", () => {
  const t = s.addAgentTask({
    sessionId: "persist",
    task: "digest harian",
    targetTime: wib(2026, 11, 8, 7, 30),
    repeat: "daily",
    timezone: TZ
  });

  s._reloadForTests();
  const found = s.getTask(t.id);
  assert.notEqual(found, null);
  assert.equal(found.task, "digest harian");
  assert.equal(found.repeat, "daily");
  s.removeTask("persist", t.id);
});
