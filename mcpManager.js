/**
 * mcpManager.js — Sistem Integrasi Model Context Protocol (MCP) untuk Nroz AI
 * 
 * Mengelola koneksi ke MCP Servers (seperti Playwright Browser Automation, GitHub, Database, dsb),
 * menerjemahkan definisi tool MCP ke format OpenAI function calling, dan menangani
 * eksekusi tool dua arah termasuk pengiriman screenshot gambar otomatis ke Telegram.
 */

const fs = require("fs");
const path = require("path");
const { Client } = require("./node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js");
const { StdioClientTransport } = require("./node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js");

const CONFIG_PATH = path.join(__dirname, "mcp_servers.json");

// Peta client aktif: serverName -> { client, transport, tools: [] }
const activeServers = new Map();

// Peta nama tool ke handler eksekusi: toolName -> { serverName, originalName, client }
const mcpToolsRegistry = new Map();

// Definisi tool format OpenAI untuk digabungkan ke TOOL_DEFINITIONS
let mcpToolDefinitions = [];

/**
 * Membaca konfigurasi server MCP dari mcp_servers.json
 */
function loadMcpConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { mcpServers: {} };
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("[MCP] Gagal membaca mcp_servers.json:", err.message);
    return { mcpServers: {} };
  }
}

/**
 * Menginisialisasi dan menghubungkan seluruh MCP Server yang aktif
 */
async function initMCP() {
  const config = loadMcpConfig();
  const servers = config.mcpServers || {};

  mcpToolsRegistry.clear();
  mcpToolDefinitions = [];

  for (const [serverName, serverCfg] of Object.entries(servers)) {
    if (serverCfg.enabled === false) {
      console.log(`[MCP] Server '${serverName}' dinonaktifkan (enabled: false).`);
      continue;
    }

    try {
      console.log(`[MCP] Memulai koneksi ke server '${serverName}'...`);
      const env = { ...process.env, ...(serverCfg.env || {}) };
      const transport = new StdioClientTransport({
        command: serverCfg.command || "npx",
        args: serverCfg.args || [],
        env
      });

      const client = new Client(
        { name: `nroz-${serverName}-client`, version: "1.0.0" },
        { capabilities: { tools: {} } }
      );

      await client.connect(transport);

      const listRes = await client.listTools();
      const tools = listRes.tools || [];

      activeServers.set(serverName, { client, transport, tools });

      for (const t of tools) {
        // Standarisasi nama tool
        let toolName = t.name;
        if (serverCfg.toolPrefix !== undefined) {
          if (serverCfg.toolPrefix === false || serverCfg.toolPrefix === "") {
            toolName = t.name;
          } else {
            toolName = `${serverCfg.toolPrefix}${t.name}`;
          }
        } else if (!toolName.startsWith(`${serverName}_`) && !toolName.startsWith(serverName)) {
          toolName = `${serverName}_${t.name}`;
        }

        mcpToolsRegistry.set(toolName, {
          serverName,
          originalName: t.name,
          client
        });

        // Daftarkan juga alias originalName jika berbeda, agar fleksibel
        if (toolName !== t.name) {
          mcpToolsRegistry.set(t.name, {
            serverName,
            originalName: t.name,
            client
          });
        }
        // Daftarkan alias sequential_thinking jika nama aslinya sequentialthinking
        if (toolName === "sequentialthinking" || t.name === "sequentialthinking") {
          mcpToolsRegistry.set("sequential_thinking", {
            serverName,
            originalName: t.name,
            client
          });
        }

        mcpToolDefinitions.push({
          type: "function",
          function: {
            name: toolName,
            description: `[MCP: ${serverName}] ${t.description || "Tool dari MCP server"}`,
            parameters: t.inputSchema || { type: "object", properties: {} }
          }
        });
      }

      console.log(`[MCP] ✅ Server '${serverName}' berhasil terhubung (${tools.length} tool aktif).`);
    } catch (err) {
      console.error(`[MCP] ❌ Gagal menghubungkan server '${serverName}':`, err.message);
    }
  }

  return {
    connectedServers: Array.from(activeServers.keys()),
    totalTools: mcpToolsRegistry.size
  };
}

/**
 * Mengembalikan definisi tool MCP untuk digabungkan dengan tool agen
 */
function getMcpToolDefinitions() {
  return mcpToolDefinitions;
}

/**
 * Mengecek apakah tool tertentu disediakan oleh MCP
 * @param {string} name
 */
function hasMcpTool(name) {
  return mcpToolsRegistry.has(name);
}

/**
 * Menjalankan tool MCP
 * @param {string} name - Nama tool
 * @param {object} args - Argumen tool
 * @param {object} context - Konteks (sessionId, chatId, bot, dsb)
 */
async function callMcpTool(name, args = {}, context = {}) {
  const reg = mcpToolsRegistry.get(name);
  if (!reg) {
    return `❌ Tool MCP '${name}' tidak terdaftar.`;
  }

  const { client, originalName, serverName } = reg;

  try {
    const result = await client.callTool({
      name: originalName,
      arguments: args
    });

    const parts = result.content || [];
    let textOutput = "";
    const savedImages = [];

    for (const part of parts) {
      if (part.type === "text") {
        textOutput += (textOutput ? "\n" : "") + part.text;
      } else if (part.type === "image" && part.data) {
        try {
          const sessionId = context.sessionId || "default";
          const artifactsDir = path.join(__dirname, "workspace", String(sessionId), "artifacts");
          if (!fs.existsSync(artifactsDir)) {
            fs.mkdirSync(artifactsDir, { recursive: true });
          }

          const ext = part.mimeType?.includes("jpeg") ? "jpg" : "png";
          const fileName = `screenshot_${Date.now()}.${ext}`;
          const filePath = path.join(artifactsDir, fileName);

          const imgBuffer = Buffer.from(part.data, "base64");
          fs.writeFileSync(filePath, imgBuffer);
          savedImages.push({ filePath, fileName });

          // Otomatis kirim ke Telegram jika context bot & chatId tersedia!
          if (context.bot && context.chatId) {
            try {
              const sendOpts = {
                caption: `📸 *Tampilan Layar Web:* \`${fileName}\``,
                parse_mode: "Markdown"
              };
              if (context.threadId) sendOpts.message_thread_id = context.threadId;
              await context.bot.sendPhoto(context.chatId, filePath, sendOpts);
              if (typeof context.onMediaSent === "function") context.onMediaSent("photo");
            } catch (sendErr) {
              console.error("[MCP] Gagal mengirim screenshot ke Telegram:", sendErr.message);
            }
          }
        } catch (imgErr) {
          console.error("[MCP] Gagal menyimpan screenshot gambar:", imgErr.message);
        }
      }
    }

    if (savedImages.length > 0) {
      const imgNote = savedImages
        .map((img) => `📸 [Screenshot berhasil disimpan di /workspace/artifacts/${img.fileName} dan dikirim ke Telegram]`)
        .join("\n");
      textOutput = (textOutput ? textOutput + "\n\n" : "") + imgNote;
    }

    if (!textOutput) {
      textOutput = result.isError ? "❌ Operasi MCP selesai dengan error tanpa pesan teks." : "✅ Operasi MCP berhasil diselesaikan.";
    }

    return textOutput;
  } catch (err) {
    return `❌ Gagal menjalankan tool MCP '${name}' (${serverName}): ${err.message}`;
  }
}

/**
 * Menutup semua koneksi MCP server (saat bot shutdown / restart)
 */
async function closeAllMcp() {
  for (const [serverName, s] of activeServers.entries()) {
    try {
      await s.client.close();
      console.log(`[MCP] Server '${serverName}' ditutup.`);
    } catch (_) {}
  }
  activeServers.clear();
  mcpToolsRegistry.clear();
}

/**
 * Mendapatkan status ringkasan MCP
 */
function getMcpStatus() {
  const status = [];
  for (const [name, s] of activeServers.entries()) {
    status.push({
      server: name,
      toolsCount: s.tools.length,
      tools: s.tools.map((t) => t.name)
    });
  }
  return status;
}

module.exports = {
  initMCP,
  getMcpToolDefinitions,
  hasMcpTool,
  callMcpTool,
  closeAllMcp,
  getMcpStatus
};
