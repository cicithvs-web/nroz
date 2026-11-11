/**
 * agentTools.js — Pintu masuk tool-calling untuk Nroz Telegram AI Agent
 *
 * Implementasi tiap tool ada di folder tools/:
 *   tools/definitions.js  skema tool (format OpenAI function-calling)
 *   tools/shell.js        run_command, check_command_output, wait_command_output, run_code (Docker sandbox)
 *   tools/web.js          web_search, read_url, http_request
 *   tools/files.js        file_read/write/edit/list, send_photo, send_file
 *   tools/media.js        media_download, render_remotion_video, start_web_preview
 *   tools/scheduling.js   create_reminder, create_watchdog, schedule_agent_task
 *   tools/memory.js       record_decision, forget_decision, update_project_context, search_raw_memory
 *   tools/skills.js       read_skill, save_skill
 *   tools/knowledge.js    search_knowledge (RAG semantik, bot/knowledge.js)
 *   tools/ask.js          ask_user (bertanya ke user dengan tombol, menunggu jawaban)
 *   tools/videoRef.js     analyze_video_reference (analisis video referensi -> spec gaya Remotion)
 *   tools/system.js       system_info
 *   tools/describe.js     ringkasan satu baris tiap tool call untuk draft progres
 *
 * Ekspor:
 *   - TOOL_DEFINITIONS, getAllToolDefinitions() : skema tool (bawaan + MCP)
 *   - executeTool(name, args, context)          : menjalankan tool, selalu mengembalikan string
 *   - describeToolCall(name, args)
 */

const mcpManager = require("./mcpManager.js");
const { runSubagent, runParallelSubagents } = require("./subagentManager.js");
const { TOOL_DEFINITIONS } = require("./tools/definitions");
const { describeToolCall } = require("./tools/describe");
const shell = require("./tools/shell");
const web = require("./tools/web");
const files = require("./tools/files");
const media = require("./tools/media");
const scheduling = require("./tools/scheduling");
const memory = require("./tools/memory");
const skills = require("./tools/skills");
const system = require("./tools/system");
const knowledge = require("./tools/knowledge");
const ask = require("./tools/ask");
const videoRef = require("./tools/videoRef");
const computer = require("./tools/computer");

/**
 * Tool: delegate_task
 * Ada di sini (bukan di tools/) karena subagent butuh executeTool dan TOOL_DEFINITIONS.
 */
async function toolDelegateTask({ role, role_description, task, max_rounds, sessionId, client, model, onSubagentProgress }) {
  if (!task) return "❌ Parameter 'task' (instruksi tugas) wajib diisi.";
  const safeRole = role || "general";
  try {
    const res = await runSubagent({
      role: safeRole,
      roleDescription: role_description,
      task,
      sessionId: sessionId || "default",
      maxRounds: max_rounds || 10,
      client,
      model,
      onProgress: onSubagentProgress,
      executeTool,
      allToolDefinitions: getAllToolDefinitions()
    });

    return (
      `🤖 [Laporan Subagent: ${res.role.toUpperCase()}] (selesai dalam ${res.roundsUsed} langkah):\n\n` +
      `${res.report}`
    );
  } catch (err) {
    return `❌ Gagal menjalankan subagent ${safeRole}: ${err.message}`;
  }
}

/**
 * Tool: delegate_parallel_tasks
 * Menjalankan 2–4 subagent sekaligus secara paralel (Swarm / Map-Reduce).
 */
async function toolDelegateParallelTasks({ tasks, sessionId, client, model, onSubagentProgress }) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return "❌ Parameter 'tasks' wajib berupa array berisi minimal 1 objek { role, task }.";
  }
  try {
    const results = await runParallelSubagents({
      tasks,
      sessionId: sessionId || "default",
      client,
      model,
      onProgress: onSubagentProgress,
      executeTool,
      allToolDefinitions: getAllToolDefinitions()
    });

    const blocks = results.map((res, idx) => {
      const icon = res.success !== false ? "🤖" : "⚠️";
      return (
        `${icon} **[Subagent #${idx + 1}: ${String(res.role || "general").toUpperCase()}]** (${res.roundsUsed} langkah):\n` +
        `${res.report}`
      );
    });

    return (
      `⚡ **[Laporan Swarm Paralel: ${results.length} Subagent Selesai]**\n\n` +
      blocks.join("\n\n---\n\n")
    );
  } catch (err) {
    return `❌ Gagal menjalankan swarm subagent paralel: ${err.message}`;
  }
}

/**
 * Peta nama tool ke fungsi implementasinya.
 * Setiap fungsi menerima objek args dan mengembalikan string.
 */
const TOOL_HANDLERS = {
  run_command: shell.toolRunCommand,
  check_command_output: shell.toolCheckCommandOutput,
  wait_command_output: shell.toolWaitCommandOutput,
  run_code: shell.toolRunCode,
  web_search: web.toolWebSearch,
  read_url: web.toolReadUrl,
  system_info: system.toolSystemInfo,
  file_read: files.toolFileRead,
  file_write: files.toolFileWrite,
  file_edit: files.toolFileEdit,
  file_list: files.toolFileList,
  code_search: files.toolCodeSearch,
  workspace_undo: files.toolWorkspaceUndo,
  http_request: web.toolHttpRequest,
  start_web_preview: media.toolStartWebPreview,
  create_reminder: scheduling.toolCreateReminder,
  create_watchdog: scheduling.toolCreateWatchdog,
  schedule_agent_task: scheduling.toolScheduleAgentTask,
  search_knowledge: knowledge.toolSearchKnowledge,
  save_knowledge: knowledge.toolSaveKnowledge,
  ask_user: ask.toolAskUser,
  computer_use: computer.toolComputerUse,
  analyze_video_reference: videoRef.toolAnalyzeVideoReference,
  media_download: media.toolMediaDownload,
  render_remotion_video: media.toolRenderRemotionVideo,
  record_decision: memory.toolRecordDecision,
  forget_decision: memory.toolForgetDecision,
  update_project_context: memory.toolUpdateProjectContext,
  search_raw_memory: memory.toolSearchRawMemory,
  delegate_task: toolDelegateTask,
  delegate_parallel_tasks: toolDelegateParallelTasks,
  send_photo: files.toolSendPhoto,
  send_file: files.toolSendFile,
  read_skill: skills.toolReadSkill,
  save_skill: skills.toolSaveSkill,
};

/**
 * Mengembalikan seluruh tool definitions gabungan (Tool Bawaan + Tool MCP Aktif)
 */
function getAllToolDefinitions() {
  return [...TOOL_DEFINITIONS, ...mcpManager.getMcpToolDefinitions()];
}

/** Field konteks internal yang diteruskan ke handler tool lokal (bukan dari model). */
const CONTEXT_KEYS = ["sessionId", "chatId", "threadId", "client", "model", "bot", "onMediaSent", "onSubagentProgress"];

/**
 * Menjalankan tool berdasarkan nama, argumen, dan context (sessionId dsb).
 * Selalu mengembalikan string — tidak pernah melempar error.
 */
async function executeTool(name, args, context = {}) {
  try {
    // 1. Tool dari MCP Server: HANYA argumen murni dari model. Objek context (bot, client)
    // punya referensi melingkar yang membuat JSON.stringify di transport MCP gagal.
    if (mcpManager.hasMcpTool(name)) {
      const mcpArgs = typeof args === "object" && args !== null ? { ...args } : {};
      return await mcpManager.callMcpTool(name, mcpArgs, context);
    }

    // 2. Argumen untuk handler tool lokal. Field konteks selalu ditimpa dari context,
    // jadi model tidak bisa memalsukan sessionId/chatId lewat argumen tool.
    const safeArgs = typeof args === "object" && args !== null ? { ...args } : {};
    for (const key of CONTEXT_KEYS) {
      delete safeArgs[key];
      if (context && context[key] !== undefined) safeArgs[key] = context[key];
    }

    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      return `❌ Tool '${name}' tidak ditemukan. Tool yang tersedia: ${Object.keys(TOOL_HANDLERS).join(", ")}`;
    }

    const result = await handler(safeArgs);
    return typeof result === "string" ? result : String(result);
  } catch (err) {
    // Lapisan keamanan terakhir — jangan pernah lempar error ke pemanggil
    return `❌ Error tak terduga saat menjalankan tool '${name}': ${err.message}`;
  }
}

module.exports = {
  TOOL_DEFINITIONS,
  getAllToolDefinitions,
  executeTool,
  describeToolCall,
};
