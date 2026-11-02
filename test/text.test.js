const test = require("node:test");
const assert = require("node:assert/strict");
const { splitMessage, cleanAnswer, cleanFileTags, isParseError } = require("../bot/text");
const { extractFilesFromAnswer, extractZipName } = require("../bot/fileExtract");

test("teks pendek tidak dipecah", () => {
  assert.deepEqual(splitMessage("halo", 100), ["halo"]);
});

test("setiap potongan tidak melebihi batas", () => {
  const text = Array.from({ length: 300 }, (_, i) => `baris ke-${i} ${"x".repeat(40)}`).join("\n");
  const parts = splitMessage(text, 1000);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 1000, `panjang ${p.length}`);
  assert.equal(parts.join("\n").replace(/\n/g, ""), text.replace(/\n/g, ""));
});

test("satu baris yang sangat panjang dipotong paksa", () => {
  const parts = splitMessage("a".repeat(10_000), 4000);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= 4000);
  assert.equal(parts.join(""), "a".repeat(10_000));
});

test("code block yang terpotong ditutup lalu dibuka lagi", () => {
  const code = Array.from({ length: 200 }, (_, i) => `console.log(${i});`).join("\n");
  const text = "Ini kodenya:\n```js\n" + code + "\n```\nSelesai.";
  const parts = splitMessage(text, 1000);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    const fences = (p.match(/^```/gm) || []).length;
    assert.equal(fences % 2, 0, `fence tidak seimbang:\n${p.slice(0, 80)}`);
    assert.ok(p.length <= 1000);
  }
  assert.ok(parts[1].startsWith("```js\n"));
});

test("cleanAnswer dan cleanFileTags", () => {
  assert.equal(cleanAnswer("**tebal** ### Judul"), "*tebal* Judul");
  assert.equal(cleanFileTags("a <<<SENDFILE:/workspace/x.zip>>> b").trim(), "a  b");
});

test("isParseError mengenali error Markdown Telegram", () => {
  assert.equal(isParseError(new Error("ETELEGRAM: 400 Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 12")), true);
  assert.equal(isParseError(new Error("ETELEGRAM: 403 Forbidden: bot was blocked by the user")), false);
});

test("extractFilesFromAnswer membaca tag FILE dan code block bila diminta", () => {
  const tagged = extractFilesFromAnswer("<<<FILE:src/app.js>>>\nconsole.log(1)\n<<<ENDFILE>>>");
  assert.deepEqual(tagged, [{ filename: "src/app.js", content: "console.log(1)" }]);

  const blocks = extractFilesFromAnswer("```python\nprint(1)\n```", "buatkan file script python");
  assert.deepEqual(blocks, [{ filename: "main.py", content: "print(1)" }]);

  assert.deepEqual(extractFilesFromAnswer("```python\nprint(1)\n```", "apa itu python?"), []);
  assert.equal(extractFilesFromAnswer("<<<FILE:../../etc/x>>>\na\n<<<ENDFILE>>>")[0].filename, "etc/x");
  assert.equal(extractZipName("<<<ZIP:hasil.zip>>>"), "hasil.zip");
});
