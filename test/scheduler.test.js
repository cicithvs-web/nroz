const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Arahkan scheduler ke file sementara SEBELUM modul dimuat.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nroz-sched-"));
process.env.SCHEDULER_DATA_FILE = path.join(tmpDir, "scheduler_data.json");
const s = require("../schedulerManager");

const TZ = "Asia/Jakarta";
const wib = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 7, mi); // WIB = UTC+7

test("parseAt: tanggal-jam WIB", () => {
  assert.equal(s.parseAt("2026-11-02 08:00", TZ), wib(2026, 11, 2, 8, 0));
  assert.equal(s.parseAt("2026-11-02T08:30", TZ), wib(2026, 11, 2, 8, 30));
  assert.equal(s.parseAt("2026-11-02 08:00", "Asia/Jayapura"), Date.UTC(2026, 10, 1, 23, 0));
});

test("parseAt: HH:mm berarti kejadian berikutnya", () => {
  const now = wib(2026, 11, 1, 22, 0);
  assert.equal(s.parseAt("23:15", TZ, now), wib(2026, 11, 1, 23, 15));
  assert.equal(s.parseAt("08:00", TZ, now), wib(2026, 11, 2, 8, 0));
});

test("parseAt: ISO dengan offset dan input tidak valid", () => {
  assert.equal(s.parseAt("2026-11-02T08:00:00+07:00", TZ), wib(2026, 11, 2, 8, 0));
  assert.throws(() => s.parseAt("besok pagi", TZ), /tidak dikenali/);
  assert.throws(() => s.parseAt("2026-02-30 08:00", TZ), /tidak valid/);
  assert.throws(() => s.parseAt("25:00", TZ), /tidak valid/);
});

test("nextOccurrence: harian, mingguan, hari kerja", () => {
  const mon8 = wib(2026, 11, 2, 8, 0); // Senin
  assert.equal(s.nextOccurrence(mon8, "daily", TZ, mon8), wib(2026, 11, 3, 8, 0));
  assert.equal(s.nextOccurrence(mon8, "weekly", TZ, mon8), wib(2026, 11, 9, 8, 0));
  const fri8 = wib(2026, 11, 6, 8, 0); // Jumat
  assert.equal(s.nextOccurrence(fri8, "weekdays", TZ, fri8), wib(2026, 11, 9, 8, 0));
});

test("nextOccurrence: bulanan menjaga tanggal 31 di bulan pendek", () => {
  const jan31 = wib(2027, 1, 31, 9, 0);
  const feb = s.nextOccurrence(jan31, "monthly", TZ, jan31, 31);
  assert.equal(feb, wib(2027, 2, 28, 9, 0));
  assert.equal(s.nextOccurrence(feb, "monthly", TZ, feb, 31), wib(2027, 3, 31, 9, 0));
});

test("nextOccurrence: jadwal yang terlewat saat bot mati dilompati", () => {
  const old = wib(2026, 10, 1, 8, 0);
  const now = wib(2026, 11, 1, 12, 0);
  assert.equal(s.nextOccurrence(old, "daily", TZ, now), wib(2026, 11, 2, 8, 0));
});

test("nextOccurrence menghormati DST di zona lain", () => {
  // New York: 2026-11-01 kembali ke EST. 08:00 tetap 08:00 waktu lokal.
  const before = s.parseAt("2026-10-31 08:00", "America/New_York");
  const after = s.nextOccurrence(before, "daily", "America/New_York", before);
  assert.equal(after - before, 25 * 3600_000);
  assert.equal(s.getZonedParts(after, "America/New_York").hour, 8);
});

test("splitSessionId", () => {
  assert.deepEqual(s.splitSessionId("-1001234_t56"), { chatId: "-1001234", threadId: 56 });
  assert.deepEqual(s.splitSessionId("7368157605"), { chatId: "7368157605", threadId: null });
});

test("pengingat: dikirim dulu baru dihapus, gagal sementara dicoba lagi, berulang dijadwalkan ulang", async () => {
  const sent = [];
  let failNext = 0;
  const fakeBot = {
    sendMessage: async (chatId, text, opts) => {
      if (failNext > 0) {
        failNext--;
        throw new Error("ETIMEDOUT");
      }
      sent.push({ chatId, text, opts });
      return { message_id: sent.length };
    }
  };
  s.initScheduler(fakeBot);

  const now = Date.now();
  const once = s.addReminder({ sessionId: "-100_t7", chatId: "-100", threadId: 7, message: "minum air", targetTime: now - 1000 });
  const daily = s.addReminder({ sessionId: "42", chatId: "42", message: "standup", targetTime: now - 500, repeat: "daily" });

  failNext = 1; // pengingat pertama gagal sekali
  await s.checkReminders(now);
  assert.ok(s.getTask(once.id), "pengingat yang gagal terkirim harus tetap ada");
  assert.equal(s.getTask(once.id).attempts, 1);
  const dailyAfter = s.getTask(daily.id);
  assert.ok(dailyAfter.targetTime > now, "pengingat harian dijadwalkan ulang");
  assert.equal(sent.at(-1).opts.reply_markup.inline_keyboard[0][0].callback_data, `task_cancel:${daily.id}`);

  await s.checkReminders(now);
  assert.equal(s.getTask(once.id), null, "terkirim lalu dihapus");
  const first = sent.find((m) => m.text.includes("minum air"));
  assert.equal(first.chatId, "-100");
  assert.equal(first.opts.message_thread_id, 7);

  // Data tersimpan atomik dan bisa dibaca ulang
  const saved = JSON.parse(fs.readFileSync(process.env.SCHEDULER_DATA_FILE, "utf-8"));
  assert.equal(saved.reminders.length, 1);
  assert.equal(saved.reminders[0].id, daily.id);
  assert.deepEqual(fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp")), []);

  assert.equal(s.removeTask("lain", daily.id), false, "sesi lain tidak bisa membatalkan");
  assert.equal(s.removeTask("42", daily.id), true);
});

test("pengingat dibuang setelah error permanen", async () => {
  s.initScheduler({ sendMessage: async () => { throw new Error("ETELEGRAM: 403 Forbidden: bot was blocked by the user"); } });
  const r = s.addReminder({ sessionId: "9", chatId: "9", message: "x", targetTime: Date.now() - 1 });
  await s.checkReminders(Date.now());
  assert.equal(s.getTask(r.id), null);
});

test("file data lama (tanpa sessionId) tetap terbaca", () => {
  fs.writeFileSync(
    process.env.SCHEDULER_DATA_FILE,
    JSON.stringify({ reminders: [{ id: "rem_old", chatId: "-55_t3", message: "lama", targetTime: Date.now() + 60000 }], watchdogs: [] })
  );
  s._reloadForTests();
  const r = s.getTask("rem_old");
  assert.equal(r.sessionId, "-55_t3");
  assert.equal(r.chatId, "-55");
  assert.equal(r.threadId, 3);
  assert.equal(r.repeat, "none");
});

test("file data rusak disimpan sebagai salinan, tidak ditimpa diam-diam", () => {
  fs.writeFileSync(process.env.SCHEDULER_DATA_FILE, "{ rusak");
  s._reloadForTests();
  assert.ok(fs.readdirSync(tmpDir).some((f) => f.includes(".corrupt-")));
});

test("watchdog menolak URL internal", async () => {
  await assert.rejects(s.addWatchdog({ sessionId: "1", chatId: "1", url: "http://127.0.0.1:8080" }), /internal/);
});
