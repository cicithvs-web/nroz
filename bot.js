/**
 * bot.js — Titik masuk Nroz AI Agent Telegram Bot.
 *
 * Isi bot ada di folder bot/:
 *   bot/config.js         model, Base URL, API key, client OpenAI
 *   bot/send.js, text.js  pengiriman pesan (fallback Markdown, pemecahan pesan panjang)
 *   bot/access.js         approval user & filter pesan grup
 *   bot/agentLoop.js      loop tool-calling AI + checkpoint giliran terpotong
 *   bot/commands.js       perintah slash dan menu perintah
 *   bot/callbacks.js      tombol inline (approval, batal tugas)
 *   bot/handlers.js       pesan teks, foto, dokumen, suara
 *   bot/fileDelivery.js   kiriman file/ZIP dari jawaban AI
 *   bot/renderDelivery.js progres & hasil render video
 *   bot/workspace.js      folder workspace & auto-cleanup
 */

process.env.NTBA_FIX_350 = 1;
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");

const ctx = require("./bot/context");
const { syncConfigFromDb } = require("./bot/config");
const { initScheduler } = require("./schedulerManager.js");
const { initWebhooks } = require("./webhookManager.js");
const { initMCP, closeAllMcp } = require("./mcpManager.js");
const { startAutoCleanup } = require("./bot/workspace");
const { registerRenderDelivery } = require("./bot/renderDelivery");
const { registerCommands, registerBotCommands } = require("./bot/commands");
const { registerCallbacks } = require("./bot/callbacks");
const { registerHandlers } = require("./bot/handlers");

// Error yang lolos dari handler async tidak boleh mematikan bot (Node >= 15 keluar
// pada unhandled rejection). Dicatat lengkap supaya penyebabnya tetap terlihat.
process.on("unhandledRejection", (reason) => {
  console.error("[Unhandled Rejection]", reason instanceof Error ? reason.stack : reason);
});
// Exception sinkron yang tidak tertangkap membuat state proses tidak bisa dipercaya,
// jadi dicatat lalu keluar dengan rapi; pm2 menyalakan ulang bot.
process.on("uncaughtException", (err) => {
  console.error("[Uncaught Exception]", err.stack || err);
  closeAllMcp()
    .catch(() => {})
    .finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 5000).unref();
});

if (!process.env.BOT_TOKEN) {
  console.error("[Bot] BOT_TOKEN belum diisi di .env");
  process.exit(1);
}

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
ctx.bot = bot;

initScheduler(bot);
initWebhooks(bot);

initMCP()
  .then((res) => {
    console.log(`[MCP Ready] ${res.connectedServers.length} server terhubung, ${res.totalTools} tool MCP aktif.`);
  })
  .catch((err) => {
    console.warn(`[MCP Init Warning]:`, err.message);
  });

syncConfigFromDb();
startAutoCleanup(3);

bot
  .getMe()
  .then((me) => {
    if (me && me.username) {
      ctx.botUsername = me.username;
      console.log(`[Bot] Terhubung sebagai @${me.username} (ID: ${me.id})`);
    }
    if (me && !me.can_read_all_group_messages) {
      console.warn(
        `[Bot Warning] Group Privacy Mode aktif (can_read_all_group_messages: false). Telegram TIDAK AKAN mengirim pesan biasa di supergroup ke bot kecuali ditag! Jadikan bot sebagai Admin di supergroup atau matikan Privacy Mode via @BotFather.`
      );
    }
  })
  .catch((err) => {
    console.warn("[Bot] Gagal membaca info profil bot:", err.message);
  });

registerCommands(bot);
registerCallbacks(bot);
registerHandlers(bot);
registerRenderDelivery();
registerBotCommands(bot);

bot.on("polling_error", (error) => {
  console.log(`[Polling Error]: ${error.message}`);
});

async function shutdown() {
  await closeAllMcp();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
