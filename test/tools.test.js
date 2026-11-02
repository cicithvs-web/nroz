const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Jangan sentuh scheduler_data.json milik bot yang sedang berjalan.
process.env.SCHEDULER_DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nroz-tools-")), "scheduler.json");

const { buildYtDlpArgs } = require("../tools/media");
const { executeTool } = require("../agentTools");
const { WORKSPACE_BASE } = require("../lib/paths");
const { writeUploadSafely } = require("../bot/handlers");

test("yt-dlp dipanggil dengan argumen terpisah, URL setelah --", () => {
  const evil = 'https://x.com/"; touch /tmp/pwned; "$(id)';
  const args = buildYtDlpArgs(evil, "audio", "/w/%(title)s.%(ext)s");
  assert.equal(args.at(-1), evil);
  assert.equal(args.at(-2), "--");
  assert.ok(args.includes("-x"));
  assert.ok(buildYtDlpArgs("https://a.b", "video", "/o").includes("best[ext=mp4]/best"));
});

test("tool file menolak path host dan symlink keluar workspace", async () => {
  const sid = `test_tools_${process.pid}_${Date.now()}`;
  const ws = path.join(WORKSPACE_BASE, sid);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nroz-out-"));
  fs.writeFileSync(path.join(outside, "rahasia.txt"), "rahasia");
  try {
    const ctx = { sessionId: sid };
    assert.match(await executeTool("file_read", { path: "/root/nroz/.env" }, ctx), /^⛔/);
    assert.match(await executeTool("file_write", { path: "/root/.ssh/authorized_keys", content: "x" }, ctx), /^⛔/);
    assert.match(await executeTool("file_list", { path: "/etc" }, ctx), /^⛔/);
    assert.match(await executeTool("send_file", { file_path: "/root/nroz/config.json" }, ctx), /^⛔/);

    assert.match(await executeTool("file_write", { path: "/workspace/a.txt", content: "halo" }, ctx), /^✅/);
    assert.match(await executeTool("file_read", { path: "a.txt" }, ctx), /halo/);
    assert.match(await executeTool("file_edit", { path: "a.txt", target: "halo", replacement: "hai" }, ctx), /^✅/);

    fs.symlinkSync(path.join(outside, "rahasia.txt"), path.join(ws, "link.txt"));
    assert.match(await executeTool("file_read", { path: "/workspace/link.txt" }, ctx), /symlink/);
    assert.match(await executeTool("send_photo", { file_path: "/workspace/link.txt" }, ctx), /symlink/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("argumen model tidak bisa memalsukan sessionId/chatId", async () => {
  const sid = `test_ctx_${process.pid}_${Date.now()}`;
  try {
    const res = await executeTool("file_write", { path: "x.txt", content: "1", sessionId: "7368157605" }, { sessionId: sid });
    assert.match(res, /^✅/);
    assert.ok(fs.existsSync(path.join(WORKSPACE_BASE, sid, "x.txt")));
  } finally {
    fs.rmSync(path.join(WORKSPACE_BASE, sid), { recursive: true, force: true });
  }
});

test("media_download dan http_request menolak alamat internal", async () => {
  assert.match(await executeTool("media_download", { url: "http://127.0.0.1:8080/x" }, { sessionId: "t" }), /^⛔/);
  assert.match(await executeTool("http_request", { method: "GET", url: "http://169.254.169.254/" }, { sessionId: "t" }), /^⛔/);
  assert.match(await executeTool("read_url", { url: "http://localhost/" }, { sessionId: "t" }), /^⛔/);
  fs.rmSync(path.join(WORKSPACE_BASE, "t"), { recursive: true, force: true });
});

test("upload tidak menulis menembus symlink", () => {
  const sid = `test_up_${process.pid}_${Date.now()}`;
  const ws = path.join(WORKSPACE_BASE, sid);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nroz-up-"));
  const target = path.join(outside, "authorized_keys");
  fs.writeFileSync(target, "asli");
  try {
    fs.mkdirSync(path.join(ws, "uploads"), { recursive: true });
    fs.symlinkSync(target, path.join(ws, "uploads", "authorized_keys"));
    writeUploadSafely(sid, path.join(ws, "uploads", "authorized_keys"), Buffer.from("kiriman user"));
    assert.equal(fs.readFileSync(target, "utf-8"), "asli");
    assert.equal(fs.readFileSync(path.join(ws, "uploads", "authorized_keys"), "utf-8"), "kiriman user");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("create_reminder dengan jam absolut dan pengulangan", async () => {
  const sid = `test_rem_${process.pid}`;
  const res = await executeTool(
    "create_reminder",
    { message: "standup", at: "09:00", repeat: "weekdays" },
    { sessionId: sid, chatId: 123 }
  );
  assert.match(res, /Pengingat berhasil dijadwalkan/);
  assert.match(res, /setiap hari kerja/);
  assert.match(res, /WIB/);
  assert.match(await executeTool("create_reminder", { message: "x" }, { sessionId: sid }), /Isi salah satu/);
  assert.match(await executeTool("create_reminder", { message: "x", at: "2020-01-01 08:00" }, { sessionId: sid }), /sudah lewat/);

  const s = require("../schedulerManager");
  for (const r of s.listTasks(sid).reminders) s.removeTask(sid, r.id);
});
