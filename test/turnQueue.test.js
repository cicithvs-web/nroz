const test = require("node:test");
const assert = require("node:assert/strict");
const { TurnQueue, QueueFullError } = require("../bot/turnQueue");

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("tugas di sesi yang sama berjalan berurutan, tidak tumpang tindih", async () => {
  const q = new TurnQueue();
  const log = [];
  let active = 0;
  let maxActive = 0;
  const job = (name, ms) => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    log.push(`mulai ${name}`);
    await tick(ms);
    log.push(`selesai ${name}`);
    active--;
    return name;
  };

  const results = await Promise.all([q.run("s1", job("A", 30)), q.run("s1", job("B", 5)), q.run("s1", job("C", 5))]);
  assert.deepEqual(results, ["A", "B", "C"]);
  assert.equal(maxActive, 1);
  assert.deepEqual(log, ["mulai A", "selesai A", "mulai B", "selesai B", "mulai C", "selesai C"]);
});

test("sesi berbeda berjalan paralel", async () => {
  const q = new TurnQueue();
  let active = 0;
  let maxActive = 0;
  const job = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await tick(20);
    active--;
  };
  await Promise.all([q.run("a", job), q.run("b", job), q.run("c", job)]);
  assert.equal(maxActive, 3);
});

test("onQueued dipanggil dengan nomor urut hanya untuk yang menunggu", async () => {
  const q = new TurnQueue();
  const positions = [];
  const p1 = q.run("s", () => tick(20), { onQueued: (n) => positions.push(["p1", n]) });
  const p2 = q.run("s", () => tick(1), { onQueued: (n) => positions.push(["p2", n]) });
  const p3 = q.run("s", () => tick(1), { onQueued: (n) => positions.push(["p3", n]) });
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(positions, [["p2", 1], ["p3", 2]]);
});

test("antrean penuh ditolak dengan QueueFullError", async () => {
  const q = new TurnQueue({ maxPending: 2 });
  const running = q.run("s", () => tick(30));
  const w1 = q.run("s", () => tick(1));
  const w2 = q.run("s", () => tick(1));
  await assert.rejects(q.run("s", () => tick(1)), QueueFullError);
  await Promise.all([running, w1, w2]);
  // setelah kosong, sesi bisa dipakai lagi
  assert.equal(await q.run("s", async () => "ok"), "ok");
});

test("tugas yang gagal tidak memutus rantai antrean", async () => {
  const q = new TurnQueue();
  const p1 = q.run("s", async () => {
    await tick(5);
    throw new Error("meledak");
  });
  const p2 = q.run("s", async () => "tetap jalan");
  await assert.rejects(p1, /meledak/);
  assert.equal(await p2, "tetap jalan");
  assert.equal(q.isBusy("s"), false);
});

test("cancelPending membuang yang menunggu tapi tidak menyentuh yang berjalan", async () => {
  const q = new TurnQueue();
  const ran = [];
  const p1 = q.run("s", async () => {
    await tick(30);
    ran.push("A");
    return "A";
  });
  const p2 = q.run("s", async () => ran.push("B"));
  const p3 = q.run("s", async () => ran.push("C"));
  assert.equal(q.pendingCount("s"), 2);
  assert.equal(q.cancelPending("s"), 2);
  assert.equal(await p1, "A");
  assert.equal(await p2, undefined);
  assert.equal(await p3, undefined);
  assert.deepEqual(ran, ["A"]);
  assert.equal(q.cancelPending("tidak-ada"), 0);
  assert.equal(q.isBusy("s"), false);
});
