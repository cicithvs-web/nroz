const test = require("node:test");
const assert = require("node:assert/strict");
const { fixMcpArgs, describeArgsShape } = require("../lib/mcpArgs");

const base = { thought: "x", thoughtNumber: 1, totalThoughts: 3, nextThoughtNeeded: true };

test("revisesThought: 0 dihapus (kasus nyata dari log produksi)", () => {
  const { args, fixes } = fixMcpArgs("sequentialthinking", { ...base, revisesThought: 0, needsMoreThoughts: true });
  assert.equal("revisesThought" in args, false);
  assert.equal(args.needsMoreThoughts, true);
  assert.equal(args.thought, "x");
  assert.equal(fixes.length, 1);
});

test("nilai kosong untuk revisesThought/branchFromThought dihapus, nilai valid dibiarkan", () => {
  for (const empty of [0, "0", "", null, false]) {
    const { args } = fixMcpArgs("sequentialthinking", { ...base, revisesThought: empty, branchFromThought: empty });
    assert.equal("revisesThought" in args, false, JSON.stringify(empty));
    assert.equal("branchFromThought" in args, false, JSON.stringify(empty));
  }
  const kept = fixMcpArgs("sequentialthinking", { ...base, isRevision: true, revisesThought: 2, branchFromThought: 1, branchId: "b" });
  assert.equal(kept.args.revisesThought, 2);
  assert.equal(kept.args.branchFromThought, 1);
  assert.equal(kept.args.branchId, "b");
  assert.deepEqual(kept.fixes, []);
});

test("parameter opsional bernilai null dihapus", () => {
  const { args } = fixMcpArgs("sequentialthinking", { ...base, isRevision: null, branchId: null, needsMoreThoughts: null });
  for (const k of ["isRevision", "branchId", "needsMoreThoughts"]) assert.equal(k in args, false, k);
});

test("nextThoughtNeeded hilang/null/kosong -> true, boolean yang sah tidak diubah", () => {
  const { thought, thoughtNumber, totalThoughts } = base;
  const missing = fixMcpArgs("sequentialthinking", { thought, thoughtNumber, totalThoughts });
  assert.equal(missing.args.nextThoughtNeeded, true);
  assert.match(missing.fixes[0], /hilang/);
  assert.equal(fixMcpArgs("sequentialthinking", { thought, nextThoughtNeeded: null }).args.nextThoughtNeeded, true);
  assert.equal(fixMcpArgs("sequentialthinking", { thought, nextThoughtNeeded: "" }).args.nextThoughtNeeded, true);

  assert.equal(fixMcpArgs("sequentialthinking", { ...base, nextThoughtNeeded: false }).args.nextThoughtNeeded, false);
  assert.equal(fixMcpArgs("sequentialthinking", { ...base, nextThoughtNeeded: true }).fixes.length, 0);
  // string "false" sah bagi server (coercedBoolean), jangan diubah jadi true
  assert.equal(fixMcpArgs("sequentialthinking", { ...base, nextThoughtNeeded: "false" }).args.nextThoughtNeeded, "false");
  assert.equal(fixMcpArgs("sequentialthinking", { ...base, nextThoughtNeeded: 0 }).args.nextThoughtNeeded, false);
  assert.equal(fixMcpArgs("sequentialthinking", { ...base, nextThoughtNeeded: 1 }).args.nextThoughtNeeded, true);
});

test("argumen asli tidak dimutasi", () => {
  const input = { ...base, revisesThought: 0 };
  const copy = JSON.parse(JSON.stringify(input));
  fixMcpArgs("sequentialthinking", input);
  assert.deepEqual(input, copy);
});

test("tool lain tidak disentuh sama sekali", () => {
  const input = { url: "https://a.b", revisesThought: 0, nextThoughtNeeded: null, x: null };
  const { args, fixes } = fixMcpArgs("browser_navigate", input);
  assert.equal(args, input);
  assert.deepEqual(fixes, []);
  assert.deepEqual(fixMcpArgs("sequentialthinking", null), { args: {}, fixes: [] });
});

test("describeArgsShape tidak membocorkan isi", () => {
  const shape = JSON.parse(describeArgsShape({ thought: "rahasia banget", revisesThought: 0, n: null, tags: [1, 2], o: {}, flag: true }));
  assert.deepEqual(shape, { thought: "string(14)", revisesThought: "number(0)", n: "null", tags: "array(2)", o: "object", flag: "boolean(true)" });
  assert.ok(!describeArgsShape({ thought: "rahasia banget" }).includes("rahasia"));
});

test("browser: filename dan paths dialihkan ke workspace sesi (Opsi 2)", () => {
  const fs = require("fs");
  const { sessionWorkspacePath } = require("../lib/paths");
  const ctx = { sessionId: "user123" };
  try {
    const ss = fixMcpArgs("browser_take_screenshot", { filename: "artifacts/test.png", scale: "css" }, ctx);
    assert.ok(ss.args.filename.endsWith("/workspace/user123/artifacts/test.png"));
    assert.equal(ss.args.scale, "css");
    assert.equal(ss.fixes.length, 1);

    const snap = fixMcpArgs("browser_snapshot", { filename: "mail-page.yml" }, ctx);
    assert.ok(snap.args.filename.endsWith("/workspace/user123/mail-page.yml"));

    const empty = fixMcpArgs("browser_take_screenshot", { filename: "", scale: "css" }, ctx);
    assert.equal("filename" in empty.args, false);

    const upload = fixMcpArgs("browser_file_upload", { paths: ["uploads/doc.pdf", "/workspace/uploads/pic.png"] }, ctx);
    assert.ok(upload.args.paths[0].endsWith("/workspace/user123/uploads/doc.pdf"));
    assert.ok(upload.args.paths[1].endsWith("/workspace/user123/uploads/pic.png"));

    // Path di luar workspace wajib ditolak
    assert.throws(() => fixMcpArgs("browser_take_screenshot", { filename: "../../outside.png" }, ctx), /di luar workspace/i);
    assert.throws(() => fixMcpArgs("browser_file_upload", { paths: ["../../outside.txt"] }, ctx), /di luar workspace/i);
    assert.throws(() => fixMcpArgs("browser_file_upload", { paths: ["/opt/nroz/.env"] }, ctx), /di luar workspace/i);

    // URL localhost/127.0.0.1 diarahkan otomatis ke IP container sandbox sesi jika tersedia
    const nav = fixMcpArgs("browser_navigate", { url: "http://localhost:3000/dashboard?x=1" }, { sessionId: "user123", sandboxIp: "172.17.0.9" });
    assert.equal(nav.args.url, "http://172.17.0.9:3000/dashboard?x=1");
    assert.equal(nav.fixes.length, 1);

    // Normalisasi target ref=f3e106 / [ref=e42] / { ref: "f3e106" } agar Playwright MCP tidak gagal Unknown engine "ref"
    const click1 = fixMcpArgs("browser_click", { target: "ref=f3e106" }, ctx);
    assert.equal(click1.args.target, "f3e106");
    const click2 = fixMcpArgs("browser_click", { target: "[ref=e42]" }, ctx);
    assert.equal(click2.args.target, "e42");
    const click3 = fixMcpArgs("browser_click", { ref: "ref=e99" }, ctx);
    assert.equal(click3.args.target, "e99");
    assert.equal("ref" in click3.args, false);
  } finally {
    try {
      fs.rmSync(sessionWorkspacePath("user123"), { recursive: true, force: true });
    } catch (_) {}
  }
});
