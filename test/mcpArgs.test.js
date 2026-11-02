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
