/**
 * bot/context.js — Instance bot Telegram yang dipakai bersama semua modul bot/.
 *
 * Diisi sekali oleh bot.js saat start. Modul lain membaca `ctx.bot` saat dipanggil,
 * jadi fungsi murni di bot/ tetap bisa di-require oleh unit test tanpa membuka polling.
 */

const ctx = {
  /** @type {import("node-telegram-bot-api")} */
  bot: null,
  botUsername: "NrozBot"
};

module.exports = ctx;
