const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeHookName,
  parseHookPath,
  truncateEventText,
  buildNotifyText,
  buildAgentPrompt
} = require("../webhookManager");

test("sanitizeHookName: valid & normalisasi", () => {
  assert.equal(sanitizeHookName("GitHub-Push"), "github-push");
  assert.equal(sanitizeHookName("  form_klien1 "), "form_klien1");
  assert.throws(() => sanitizeHookName("ab"), /3-32/);
  assert.throws(() => sanitizeHookName("a".repeat(33)), /3-32/);
  assert.throws(() => sanitizeHookName(""), /3-32/);
});

test("parseHookPath: hanya token 32-hex pada /h atau /hook", () => {
  const token = "a".repeat(32);
  assert.equal(parseHookPath(`/h/${token}`), token);
  assert.equal(parseHookPath(`/hook/${token}?x=1`), token);
  assert.equal(parseHookPath("/h/pendek"), null);
  assert.equal(parseHookPath("/lain/mana"), null);
  assert.equal(parseHookPath(`/h/${"g".repeat(31)}`), null); // 31 char
  assert.equal(parseHookPath(`/h/${"g".repeat(33)}`), null); // 33 char
  assert.equal(parseHookPath(undefined), null);
});

test("truncateEventText: memotong payload panjang dengan penanda", () => {
  const long = "y".repeat(5000);
  const cut = truncateEventText(long);
  assert.ok(cut.length < 5000);
  assert.ok(cut.endsWith("(dipotong)"));
  assert.equal(truncateEventText("  pendek  "), "pendek");
});

test("buildNotifyText & buildAgentPrompt: memuat nama hook dan payload", () => {
  const hook = { name: "github", mode: "agent" };
  const notify = buildNotifyText(hook, '{"action":"push"}');
  assert.ok(notify.includes("github"));
  assert.ok(notify.includes('{"action":"push"}'));

  const prompt = buildAgentPrompt(hook, "halo dari n8n");
  assert.ok(prompt.includes("EVENT WEBHOOK: github"));
  assert.ok(prompt.includes("halo dari n8n"));
  assert.ok(prompt.includes("--- PAYLOAD ---"));
});
