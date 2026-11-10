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

test("file_edit multi-edit, fuzzy indentation match, dan workspace_undo", async () => {
  const sid = `test_undo_${process.pid}_${Date.now()}`;
  const ws = path.join(WORKSPACE_BASE, sid);
  const ctx = { sessionId: sid };
  try {
    const initial = [
      "function greet(name) {",
      "    const msg = 'Halo ' + name;",
      "    return msg;",
      "}",
      "const port = 3000;"
    ].join("\n");

    await executeTool("file_write", { path: "app.js", content: initial }, ctx);

    // 1. Fuzzy indentation match (target memakai 2 spasi, file asli memakai 4 spasi) + multi-edit
    const editRes = await executeTool(
      "file_edit",
      {
        path: "app.js",
        edits: [
          {
            target: "  const msg = 'Halo ' + name;\n  return msg;",
            replacement: "  const msg = `Hai ${name}!`;\n  return msg.toUpperCase();"
          },
          {
            target: "const port = 3000;",
            replacement: "const port = 8080;"
          }
        ]
      },
      ctx
    );
    assert.match(editRes, /^✅/);
    assert.match(editRes, /toleransi indentasi otomatis/);

    const afterEdit = fs.readFileSync(path.join(ws, "app.js"), "utf-8");
    assert.ok(afterEdit.includes("    const msg = `Hai ${name}!`;"));
    assert.ok(afterEdit.includes("const port = 8080;"));

    // 2. List snapshot undo
    const listRes = await executeTool("workspace_undo", { action: "list" }, ctx);
    assert.match(listRes, /file_edit/);
    assert.match(listRes, /file_write/);

    // 3. Undo 1 langkah (kembalikan file_edit ke isi awal)
    const undoEdit = await executeTool("workspace_undo", { steps: 1 }, ctx);
    assert.match(undoEdit, /^⏪/);
    assert.equal(fs.readFileSync(path.join(ws, "app.js"), "utf-8"), initial);

    // 4. Undo 1 langkah lagi (batalkan file_write pembuatan file baru)
    const undoWrite = await executeTool("workspace_undo", { steps: 1 }, ctx);
    assert.match(undoWrite, /^⏪/);
    assert.equal(fs.existsSync(path.join(ws, "app.js")), false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("delegate_parallel_tasks menjalankan beberapa subagent secara paralel", async () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async ({ messages }) => {
          const userMsg = messages.find((m) => m.role === "user")?.content || "";
          return {
            choices: [
              {
                message: {
                  content: `Selesai untuk: ${userMsg.slice(0, 60)}`,
                  tool_calls: []
                }
              }
            ]
          };
        }
      }
    }
  };

  const res = await executeTool(
    "delegate_parallel_tasks",
    {
      tasks: [
        { role: "researcher", task: "Riset kompetitor A" },
        { role: "coder", task: "Buat struktur komponen B" }
      ]
    },
    { sessionId: "test_swarm", client: fakeClient, model: "fake-model" }
  );
  assert.match(res, /Laporan Swarm Paralel: 2 Subagent Selesai/);
  assert.match(res, /RESEARCHER/);
  assert.match(res, /CODER/);
});

test("analyzeScreenshotWithVision mengembalikan analisis UI dari model vision", async () => {
  const { analyzeScreenshotWithVision } = require("../mcpManager");
  const fakeClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: "1. Halaman tampil normal.\n2. Layout rapi." } }]
        })
      }
    }
  };
  const note = await analyzeScreenshotWithVision("aGVsbG8=", "image/png", { client: fakeClient, model: "vision-model" }, {});
  assert.match(note, /Halaman tampil normal/);
});

test("code_search, instant syntax checker pada file_write, dan createChatCompletionWithRetry", async () => {
  const sid = `test_search_${process.pid}_${Date.now()}`;
  const ws = path.join(WORKSPACE_BASE, sid);
  const ctx = { sessionId: sid };
  try {
    // 1. Instant Syntax Checker pada JSON & JS rusak
    const badJson = await executeTool("file_write", { path: "broken.json", content: '{ "a": 1, }' }, ctx);
    assert.match(badJson, /Peringatan Sintaks JSON/);

    const badJs = await executeTool("file_write", { path: "broken.js", content: "function x( { return 1; }" }, ctx);
    assert.match(badJs, /Peringatan Sintaks JS/);

    // 2. File valid tidak mengeluarkan peringatan sintaks
    const goodJs = await executeTool(
      "file_write",
      { path: "src/auth.js", content: "function handleUserLogin(req) {\n  return true;\n}\n" },
      ctx
    );
    assert.doesNotMatch(goodJs, /Peringatan Sintaks/);

    // 3. code_search menemukan fungsi beserta nomor baris
    const searchRes = await executeTool("code_search", { query: "handleUserLogin", file_pattern: "*.js" }, ctx);
    assert.match(searchRes, /\/workspace\/src\/auth\.js:1:/);
    assert.match(searchRes, /handleUserLogin/);

    // 4. Auto-Retry pada error timeout sementara & Multi-Model Fallback
    const { createChatCompletionWithRetry, parseFallbackModels, updateConfig } = require("../bot/config");
    assert.deepEqual(
      parseFallbackModels("glm/glm-5.3-flash deepseek/deepseek-v4.1-flash-1017, anthropic/haiku-5.5"),
      ["glm/glm-5.3-flash", "deepseek/deepseek-v4.1-flash-1017", "anthropic/haiku-5.5"]
    );
    assert.deepEqual(parseFallbackModels("off"), []);

    let calls = 0;
    const flakyClient = {
      chat: {
        completions: {
          create: async () => {
            calls++;
            if (calls < 2) throw new Error("Request timed out.");
            return { choices: [{ message: { content: "Berhasil setelah retry" } }] };
          }
        }
      }
    };
    const retryRes = await createChatCompletionWithRetry(
      flakyClient,
      { model: "test-model", messages: [] },
      { maxAttempts: 3, baseDelayMs: 10, label: "TestRetry" }
    );
    assert.equal(calls, 2);
    assert.equal(retryRes.choices[0].message.content, "Berhasil setelah retry");

    // 5. Jika model utama & fallback ke-1 gagal, lanjut ke fallback ke-2
    const prevFallbacks = require("../bot/config").getConfig().fallbackModels;
    updateConfig({ fallbackModels: ["glm/glm-5.3-flash", "deepseek/deepseek-v4.1-flash-1017"] });
    try {
      const triedModels = [];
      const multiFbClient = {
        chat: {
          completions: {
            create: async ({ model }) => {
              triedModels.push(model);
              if (model !== "deepseek/deepseek-v4.1-flash-1017") {
                throw new Error(`Model ${model} sedang penuh`);
              }
              return { choices: [{ message: { content: `Dijawab oleh ${model}` } }] };
            }
          }
        }
      };
      const fbRes = await createChatCompletionWithRetry(
        multiFbClient,
        { model: "primary-model", messages: [] },
        { maxAttempts: 1, baseDelayMs: 5, label: "TestMultiFallback" }
      );
      assert.deepEqual(triedModels, ["primary-model", "glm/glm-5.3-flash", "deepseek/deepseek-v4.1-flash-1017"]);
      assert.equal(fbRes.choices[0].message.content, "Dijawab oleh deepseek/deepseek-v4.1-flash-1017");
    } finally {
      updateConfig({ fallbackModels: prevFallbacks });
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});


