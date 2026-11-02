const test = require("node:test");
const assert = require("node:assert/strict");
const { _resolveTargetHost } = require("../webPreviewManager");
const { getSandboxIP } = require("../sandboxManager");

test("tanpa sesi, port host tidak boleh di-tunnel", async () => {
  await assert.rejects(_resolveTargetHost(42235, {}), /host tidak boleh/);
});

test("sesi tanpa container berjalan ditolak, tidak jatuh ke 127.0.0.1", async () => {
  await assert.rejects(_resolveTargetHost(42235, { sessionId: `tidak_ada_${Date.now()}` }), /belum berjalan/);
});

test("kode bot sendiri boleh membuka port host lewat allowHost", async () => {
  assert.equal(await _resolveTargetHost(4789, { allowHost: true }), "127.0.0.1");
});

test("sesi dengan container berjalan diarahkan ke IP container", async (t) => {
  const sid = "7368157605";
  const ip = getSandboxIP(sid);
  if (!ip) return t.skip("container sandbox contoh tidak berjalan");
  assert.equal(await _resolveTargetHost(42235, { sessionId: sid }), ip);
});
