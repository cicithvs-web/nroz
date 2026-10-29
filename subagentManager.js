/**
 * subagentManager.js — Sistem Orchestrasi Subagent Mandiri (Ala Antigravity) untuk Nroz AI
 *
 * Mengelola pendelegasian tugas dari Lead Agent ke Subagent spesialis (Coder, Researcher, Tester)
 * dengan context window terisolasi, hemat token, dan anti-amnesia.
 */

const OpenAI = require("openai");
const path = require("path");
const fs = require("fs");

const SUBAGENT_ALLOWED_TOOL_NAMES = new Set([
  "run_command",
  "check_command_output",
  "run_code",
  "file_read",
  "file_write",
  "file_list",
  "web_search",
  "read_url",
  "http_request"
]);

/**
 * System prompt khusus per peran subagent
 */
function getSubagentSystemPrompt(role) {
  const base =
    "Kamu adalah Subagent Spesialis mandiri di dalam sistem Nroz AI yang bekerja di lingkungan Linux VPS (Persistent Docker Sandbox).\n" +
    "Folder kerjamu ter-mount sebagai /workspace di dalam sandbox container.\n" +
    "- uploads/   : file mentah dari user (read-only referensi)\n" +
    "- work/      : area utama kamu ngoding, eksperimen, install paket, jalankan script/server\n" +
    "- artifacts/ : tempat menyimpan file hasil jadi final\n\n" +
    "ATURAN MUTLAK:\n" +
    "1. Kerjakan tugas secara mandiri dan tuntas menggunakan tools yang tersedia.\n" +
    "2. Jangan pernah menulis placeholder seperti '// TODO' atau '// tambahkan di sini'. Tulis kode/konten yang lengkap.\n" +
    "3. Setelah tugas selesai tuntas, berikan laporan akhir yang padat, jelas, dan faktual tentang apa yang telah kamu kerjakan (file yang dibuat, status pengujian, dan instruksi selanjutnya untuk Lead Agent).\n";

  switch (role) {
    case "coder":
    case "builder":
      return (
        base +
        "\nPeran Spesialis: CODER / BUILDER (Software Engineer)\n" +
        "Fokus utamamu adalah merancang arsitektur kode, membuat/mengedit file proyek di /workspace/work/, " +
        "menginstall paket dependensi bila dibutuhkan (via run_command), dan memastikan kode tidak ada error sintaks."
      );

    case "researcher":
    case "analyzer":
      return (
        base +
        "\nPeran Spesialis: RESEARCHER / ANALYZER (Information Specialist)\n" +
        "Fokus utamamu adalah melakukan penelusuran informasi mendalam dari web (web_search, read_url) " +
        "atau membedah dokumen/file di /workspace (file_read, file_list). " +
        "Sajikan ringkasan temuan yang akurat, terstruktur, padat, dan bebas dari halusinasi."
      );

    case "tester":
    case "auditor":
      return (
        base +
        "\nPeran Spesialis: TESTER / AUDITOR (Quality Assurance & Debugger)\n" +
        "Fokus utamamu adalah menguji kode, memeriksa apakah server/service berjalan (run_command, http_request), " +
        "mencari bug atau kelemahan sistem, dan melaporkan secara presisi letak kesalahan beserta solusi perbaikannya."
      );

    case "general":
    default:
      return (
        base +
        "\nPeran: GENERAL SUBAGENT\n" +
        "Fokus utamamu adalah menyelesaikan tugas spesifik yang diberikan oleh Lead Agent secara cepat, tepat, dan efisien."
      );
  }
}

/**
 * Fallback client jika tidak di-pass dari context
 */
function getDefaultClientAndModel() {
  const configFile = path.join(__dirname, "config.json");
  let apiKey = process.env.API_KEY || "";
  let baseUrl = (process.env.BASE_URL || "").replace(/\/+$/, "");
  let model = process.env.MODEL || "deepseek-v4.1-flash";

  try {
    if (fs.existsSync(configFile)) {
      const cfg = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      if (cfg.apiKey) apiKey = cfg.apiKey;
      if (cfg.baseUrl) baseUrl = cfg.baseUrl.replace(/\/+$/, "");
      if (cfg.model) model = cfg.model;
    }
  } catch (_) {}

  const client = new OpenAI({ apiKey, baseURL: baseUrl });
  return { client, model };
}

/**
 * Menjalankan Subagent mandiri dengan isolated context loop
 * @param {object} params
 * @param {string} params.role - "coder" | "researcher" | "tester" | "general"
 * @param {string} params.task - Instruksi tugas lengkap
 * @param {string} [params.sessionId="default"] - ID sesi user Telegram
 * @param {number} [params.maxRounds=10] - Maksimal langkah tool loop (default: 10, max: 20)
 * @param {object} [params.client] - OpenAI instance
 * @param {string} [params.model] - Nama model LLM
 * @param {Function} [params.onProgress] - Callback progress untuk draft Telegram
 * @param {Function} params.executeTool - Fungsi eksekutor tool dari agentTools.js
 * @param {Array} params.allToolDefinitions - Seluruh definisi tool dari agentTools.js
 */
async function runSubagent({
  role = "general",
  task,
  sessionId = "default",
  maxRounds = 10,
  client,
  model,
  onProgress,
  executeTool,
  allToolDefinitions = []
}) {
  if (!task || typeof task !== "string" || !task.trim()) {
    throw new Error("Instruksi tugas (task) untuk subagent wajib diisi.");
  }

  // Siapkan client dan model
  let activeClient = client;
  let activeModel = model;
  if (!activeClient || !activeModel) {
    const fallback = getDefaultClientAndModel();
    activeClient = activeClient || fallback.client;
    activeModel = activeModel || fallback.model;
  }

  // Filter tools: subagent hanya boleh mengakses tool teknis dasar (TIDAK boleh memanggil delegate_task lagi)
  const allowedTools = allToolDefinitions.filter(
    (t) => t.type === "function" && SUBAGENT_ALLOWED_TOOL_NAMES.has(t.function?.name)
  );

  const safeRole = ["coder", "researcher", "tester", "general"].includes(role.toLowerCase())
    ? role.toLowerCase()
    : "general";

  const systemPrompt = getSubagentSystemPrompt(safeRole);
  const currentMessages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Instruksi tugas yang harus kamu selesaikan:\n\n${task.trim()}` }
  ];

  const safeMaxRounds = Math.max(1, Math.min(Number(maxRounds) || 10, 20));
  let finalReport = "";
  let roundsUsed = 0;

  console.log(`[Subagent: ${safeRole}] Memulai tugas untuk sesi ${sessionId} (maks ${safeMaxRounds} langkah)...`);

  for (let round = 1; round <= safeMaxRounds; round++) {
    roundsUsed = round;

    let res;
    try {
      res = await activeClient.chat.completions.create({
        model: activeModel,
        messages: currentMessages,
        tools: allowedTools,
        tool_choice: "auto",
        stream: false
      });
    } catch (apiErr) {
      console.error(`[Subagent: ${safeRole}] Gagal memanggil LLM pada langkah ${round}:`, apiErr.message);
      return {
        success: false,
        role: safeRole,
        report: `❌ Subagent ${safeRole} mengalami kendala API LLM: ${apiErr.message}`,
        roundsUsed
      };
    }

    const choice = res.choices[0];
    const message = choice?.message;
    const assistantContent = message?.content || "";
    const toolCalls = message?.tool_calls || [];

    // Jika tidak ada tool calls, subagent telah menyelesaikan tugasnya dan memberikan laporan
    if (!toolCalls || toolCalls.length === 0) {
      finalReport = assistantContent || "(Subagent menyelesaikan tugas tanpa catatan teks tambahan)";
      console.log(`[Subagent: ${safeRole}] ✅ Tugas selesai pada langkah ${round}!`);
      break;
    }

    // Catat pesan assistant dengan tool_calls ke memory terisolasi subagent
    currentMessages.push({
      role: "assistant",
      content: assistantContent || null,
      tool_calls: toolCalls
    });

    // Jalankan setiap tool call yang diminta subagent
    for (const tc of toolCalls) {
      const fnName = tc.function?.name;
      let fnArgs = {};
      try {
        fnArgs = JSON.parse(tc.function?.arguments || "{}");
      } catch (_) {
        fnArgs = {};
      }

      // Pastikan subagent tidak memanggil tool di luar wewenangnya
      if (!SUBAGENT_ALLOWED_TOOL_NAMES.has(fnName)) {
        currentMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `❌ Akses ditolak: Subagent tidak memiliki izin memanggil tool '${fnName}'.`
        });
        continue;
      }

      console.log(`[Subagent: ${safeRole}] Step ${round}/${safeMaxRounds} -> ${fnName}(${JSON.stringify(fnArgs).slice(0, 100)})`);

      if (typeof onProgress === "function") {
        try {
          onProgress({
            role: safeRole,
            step: round,
            total: safeMaxRounds,
            tool: fnName,
            args: fnArgs
          });
        } catch (_) {}
      }

      let toolResult = "";
      try {
        toolResult = await executeTool(fnName, fnArgs, { sessionId });
      } catch (execErr) {
        toolResult = `❌ Error saat menjalankan tool ${fnName}: ${execErr.message}`;
      }

      currentMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: String(toolResult)
      });
    }
  }

  // Jika sampai batas langkah belum ada jawaban final, minta subagent merangkum hasil kerjanya
  if (!finalReport) {
    try {
      console.warn(`[Subagent: ${safeRole}] Batas ${safeMaxRounds} langkah tercapai. Meminta rangkuman akhir...`);
      currentMessages.push({
        role: "user",
        content: "Batas langkah tugas telah tercapai. Berikan ringkasan padat dari apa saja yang sudah berhasil kamu selesaikan dan statusnya saat ini."
      });

      const summaryRes = await activeClient.chat.completions.create({
        model: activeModel,
        messages: currentMessages,
        stream: false
      });

      finalReport = summaryRes.choices[0]?.message?.content?.trim() || "⚠️ Subagent menyelesaikan langkah kerja namun belum menghasilkan kesimpulan lengkap.";
    } catch (e) {
      finalReport = "⚠️ Batas langkah pengerjaan tercapai sebelum subagent memberikan laporan lengkap.";
    }
  }

  return {
    success: true,
    role: safeRole,
    report: finalReport,
    roundsUsed
  };
}

module.exports = {
  runSubagent,
  getSubagentSystemPrompt,
  SUBAGENT_ALLOWED_TOOL_NAMES
};
