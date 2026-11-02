const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveInWorkspace, isInside } = require("../lib/pathGuard");

function makeBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nroz-guard-"));
  fs.mkdirSync(path.join(base, "s1", "work"), { recursive: true });
  fs.mkdirSync(path.join(base, "s2"), { recursive: true });
  fs.writeFileSync(path.join(base, "s1", "work", "a.txt"), "ok");
  fs.writeFileSync(path.join(base, "secret.txt"), "secret");
  return base;
}

test("isInside", () => {
  assert.equal(isInside("/a/b/c", "/a/b"), true);
  assert.equal(isInside("/a/b", "/a/b"), true);
  assert.equal(isInside("/a/bc", "/a/b"), false);
  assert.equal(isInside("/a", "/a/b"), false);
});

test("/workspace dan path relatif dipetakan ke workspace sesi", () => {
  const base = makeBase();
  const ws = path.join(base, "s1");
  assert.deepEqual(resolveInWorkspace("/workspace/work/a.txt", "s1", { base }), { ok: true, path: path.join(ws, "work", "a.txt") });
  assert.deepEqual(resolveInWorkspace("work/a.txt", "s1", { base }), { ok: true, path: path.join(ws, "work", "a.txt") });
  assert.deepEqual(resolveInWorkspace("/workspace", "s1", { base }), { ok: true, path: ws });
  assert.equal(resolveInWorkspace(path.join(ws, "work", "a.txt"), "s1", { base }).ok, true);
  assert.equal(resolveInWorkspace("/workspace/baru/belum-ada.txt", "s1", { base }).ok, true);
});

test("path di luar workspace ditolak", () => {
  const base = makeBase();
  for (const p of [
    "/etc/passwd",
    "/root/nroz/.env",
    "../s2/x",
    "/workspace/../secret.txt",
    "/workspace/../../etc/passwd",
    path.join(base, "s2", "x"),
    path.join(base, "secret.txt")
  ]) {
    const res = resolveInWorkspace(p, "s1", { base });
    assert.equal(res.ok, false, p);
    assert.match(res.error, /luar workspace/);
  }
  assert.equal(resolveInWorkspace("", "s1", { base }).ok, false);
  assert.equal(resolveInWorkspace(null, "s1", { base }).ok, false);
});

test("symlink yang keluar dari workspace ditolak, symlink di dalam diterima", () => {
  const base = makeBase();
  const ws = path.join(base, "s1");
  fs.symlinkSync(path.join(base, "secret.txt"), path.join(ws, "link-file"));
  fs.symlinkSync(base, path.join(ws, "link-dir"));
  fs.symlinkSync(path.join(ws, "work"), path.join(ws, "link-ok"));

  assert.match(resolveInWorkspace("/workspace/link-file", "s1", { base }).error, /symlink/);
  assert.match(resolveInWorkspace("/workspace/link-dir/secret.txt", "s1", { base }).error, /symlink/);
  assert.match(resolveInWorkspace("/workspace/link-dir/file-baru.txt", "s1", { base }).error, /symlink/);
  assert.equal(resolveInWorkspace("/workspace/link-ok/a.txt", "s1", { base }).ok, true);
});

test("sessionId dengan karakter aneh tidak bisa keluar folder", () => {
  const base = makeBase();
  const res = resolveInWorkspace("/workspace/x", "../s2", { base });
  assert.equal(res.ok, true);
  assert.equal(path.dirname(res.path), path.join(base, "___s2"));
});
