/**
 * bot/dbBackup.js — Perintah /backup dan /restore database PostgreSQL (khusus owner).
 *
 * Backup menjalankan pg_dump di dalam container PostgreSQL lokal (format SQL plain
 * dengan --clean --if-exists, jadi restore ke database yang sudah terisi cukup
 * ditimpa tanpa perlu drop manual). File dump selalu dikirim ke chat PRIBADI owner
 * karena memuat bot_config termasuk API key — jangan sampai bocor ke grup.
 *
 * Restore menerima file .sql (caption /restore atau reply /restore), mengunduhnya
 * dari Telegram, lalu memipanya ke psql di container dengan ON_ERROR_STOP.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const axios = require("axios");
const ctx = require("./context");
const { replyText } = require("./send");
const { OWNER_ID, syncConfigFromDb } = require("./config");
const { ROOT_DIR } = require("../lib/paths");

const CONTAINER = process.env.POSTGRES_CONTAINER || "nroz-postgres";
// Bot API membatasi unduhan file 20 MB dan upload dokumen ~50 MB.
const MAX_RESTORE_BYTES = 20 * 1024 * 1024;
const MAX_SEND_BYTES = 49 * 1024 * 1024;

// Kredensial diambil dari DATABASE_URL (postgres://user:pass@host:port/db)
function parseDatabaseUrl() {
  try {
    const u = new URL(process.env.DATABASE_URL || "");
    return {
      user: decodeURIComponent(u.username) || "nroz",
      db: u.pathname.replace(/^\//, "") || "nroz",
      host: u.hostname || ""
    };
  } catch {
    return { user: "nroz", db: "nroz", host: "" };
  }
}

function isLocalDb(host) {
  return ["localhost", "127.0.0.1", "::1"].includes(host);
}

function notLocalReply(msg) {
  return replyText(
    msg,
    "⚠️ Perintah ini hanya untuk database lokal di container Docker. `DATABASE_URL` kamu menunjuk ke server lain — kelola backup lewat penyedia DB tersebut."
  );
}

/** Jalankan pg_dump di container, hasilnya ditulis streaming ke file (aman untuk dump besar). */
function dumpToFile(filePath, user, db) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    const child = spawn("docker", [
      "exec", CONTAINER, "pg_dump",
      "-U", user,
      "--clean", "--if-exists", "--no-owner", "--no-acl",
      db
    ]);
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdout.pipe(out);
    child.on("error", reject);
    child.on("close", (code) => {
      out.close();
      if (code === 0) resolve();
      else reject(new Error(`pg_dump gagal (kode ${code}): ${stderr.trim().slice(-400)}`));
    });
  });
}

/** Restore file .sql ke database: dipipa ke psql, berhenti di error pertama. */
function restoreFromFile(filePath, user, db) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [
      "exec", "-i", CONTAINER, "psql",
      "-U", user, "-d", db,
      "-v", "ON_ERROR_STOP=1", "-q", "-o", "/dev/null"
    ]);
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    fs.createReadStream(filePath).pipe(child.stdin);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`psql gagal (kode ${code}): ${stderr.trim().slice(-400)}`));
    });
  });
}

/** Bungkus db.sql + folder workspace/ + file state JSON (scheduler_data.json, webhooks.json, config.json) jadi satu .tar.gz. */
function tarFullBackup(outPath, stagingDir) {
  return new Promise((resolve, reject) => {
    for (const extraFile of ["scheduler_data.json", "webhooks.json", "config.json"]) {
      const src = path.join(ROOT_DIR, extraFile);
      if (fs.existsSync(src)) {
        try {
          fs.copyFileSync(src, path.join(stagingDir, extraFile));
        } catch (_) {}
      }
    }
    const stagingItems = fs.readdirSync(stagingDir);
    const args = ["-czf", outPath, "-C", stagingDir, ...stagingItems, "-C", ROOT_DIR, "workspace"];
    const child = spawn("tar", args);
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === 1) resolve(stderr.trim());
      else reject(new Error(`tar gagal (kode ${code}): ${stderr.trim().slice(-300)}`));
    });
  });
}

function formatSize(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

async function handleBackupFull(msg) {
  const { user, db, host } = parseDatabaseUrl();
  if (!isLocalDb(host)) return notLocalReply(msg);

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const backupsDir = path.join(ROOT_DIR, "backups");
  const fileName = `nroz-full-backup-${stamp}.tar.gz`;
  const outPath = path.join(backupsDir, fileName);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "nroz-full-"));

  await replyText(msg, "⏳ Membuat *full backup* (database + seluruh workspace)… bisa agak lama kalau workspace besar.");
  try {
    fs.mkdirSync(backupsDir, { recursive: true });
    await dumpToFile(path.join(staging, "db.sql"), user, db);
    await tarFullBackup(outPath, staging);

    const sizeStr = formatSize(fs.statSync(outPath).size);
    const caption =
      `📦 *Full backup Nroz* (${sizeStr})\n` +
      "• Isi: `db.sql` (database) + folder `workspace/` (termasuk profil browser `.browser-profile`) + jadwal (`scheduler_data.json`) + webhook (`webhooks.json`) + `config.json`\n\n" +
      "⚠️ *Memuat API key bot — simpan baik-baik.*\n" +
      "Restore di server baru:\n" +
      "1️⃣ Kirim file `.tar.gz` ini ke bot dengan caption `/restore` (jika <= 20 MB), ATAU\n" +
      "2️⃣ Jalankan di terminal VPS: `bash scripts/setup-vps.sh --restore=" + fileName + "`";

    if (fs.statSync(outPath).size > MAX_SEND_BYTES) {
      return await replyText(
        msg,
        `✅ Full backup selesai (${sizeStr}) tapi melebihi batas kirim Telegram (50 MB).\n\nFile tersimpan di server:\n\`${outPath}\``
      );
    }

    const targetChat = OWNER_ID ? Number(OWNER_ID) : msg.chat.id;
    await ctx.bot.sendDocument(targetChat, outPath, { caption, parse_mode: "Markdown" }, { filename: fileName, contentType: "application/gzip" });

    if (targetChat !== msg.chat.id) {
      await replyText(msg, "✅ Full backup selesai — file dikirim ke *chat pribadi* kamu dengan bot (demi keamanan isinya).");
    } else {
      await replyText(msg, `ℹ️ Salinan arsip juga tersimpan di server: \`${outPath}\``);
    }
  } catch (err) {
    fs.unlink(outPath, () => {}); // buang arsip parsial kalau gagal di tengah
    console.error("[BackupFull] gagal:", err.message);
    await replyText(msg, `❌ Full backup gagal: ${err.message}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function handleBackup(msg) {
  const { user, db, host } = parseDatabaseUrl();
  if (!isLocalDb(host)) return notLocalReply(msg);

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const fileName = `nroz-backup-${stamp}.sql`;
  const tmpPath = path.join(os.tmpdir(), fileName);

  await replyText(msg, "⏳ Membuat backup database…");
  try {
    await dumpToFile(tmpPath, user, db);
    const sizeMb = fs.statSync(tmpPath).size / (1024 * 1024);

    if (fs.statSync(tmpPath).size > MAX_SEND_BYTES) {
      return await replyText(
        msg,
        `⚠️ Backup selesai tapi ukurannya ${sizeMb.toFixed(1)} MB — melebihi batas kirim Telegram (50 MB).\n\nFile tersimpan di server:\n\`${tmpPath}\``
      );
    }

    // Selalu ke chat pribadi owner: dump memuat API key di bot_config.
    const targetChat = OWNER_ID ? Number(OWNER_ID) : msg.chat.id;
    await ctx.bot.sendDocument(targetChat, tmpPath, {
      caption:
        `💾 *Backup database Nroz* (${sizeMb >= 1 ? sizeMb.toFixed(1) + " MB" : (sizeMb * 1024).toFixed(0) + " KB"})\n` +
        `• Database: \`${db}\` @ container \`${CONTAINER}\`\n` +
        "• Format: SQL plain + `--clean --if-exists` (restore menimpa data lama)\n\n" +
        "⚠️ *File ini memuat API key bot (bot_config) — simpan baik-baik, jangan disebar.*\n" +
        "Restore: kirim file ini kembali dengan caption `/restore`, atau reply dengan `/restore`.",
      parse_mode: "Markdown"
    }, { filename: fileName, contentType: "application/sql" });

    if (targetChat !== msg.chat.id) {
      await replyText(msg, "✅ Backup selesai — file dikirim ke *chat pribadi* kamu dengan bot (demi keamanan isinya).");
    }
  } catch (err) {
    console.error("[Backup] gagal:", err.message);
    await replyText(msg, `❌ Backup gagal: ${err.message}`);
  } finally {
    // Hapus hanya kalau file memang terkirim/diabaikan; kalau disimpan karena >50MB biarkan.
    try {
      if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size <= MAX_SEND_BYTES) fs.unlinkSync(tmpPath);
    } catch {}
  }
}

async function handleRestore(msg, document) {
  const name = document && document.file_name ? document.file_name : "";
  const isTarGz = /\.(tar\.gz|tgz)$/i.test(name);
  const isSql = /\.sql$/i.test(name);
  if (!isSql && !isTarGz) {
    return replyText(msg, "⚠️ File harus berakhiran `.sql` (hasil `/backup`) atau `.tar.gz` (hasil `/backupfull`).");
  }
  const fileSize = document.file_size || 0;
  if (fileSize > MAX_RESTORE_BYTES) {
    return replyText(
      msg,
      `⚠️ File ${(fileSize / (1024 * 1024)).toFixed(1)} MB melebihi batas unduhan bot Telegram (20 MB).\n\nRestore mudah via terminal VPS:\n\`bash scripts/setup-vps.sh --restore=${name || "backup.tar.gz"}\``
    );
  }
  const { user, db, host } = parseDatabaseUrl();
  if (!isLocalDb(host)) return notLocalReply(msg);

  const ext = isTarGz ? ".tar.gz" : ".sql";
  const tmpPath = path.join(os.tmpdir(), `nroz-restore-${Date.now()}${ext}`);
  const extractDir = isTarGz ? fs.mkdtempSync(path.join(os.tmpdir(), "nroz-extract-")) : null;
  await replyText(msg, `⏳ Mengunduh \`${name}\` lalu me-restore ${isTarGz ? "Full Backup (DB + Workspace + Jadwal)" : "Database"}…`);
  try {
    const file = await ctx.bot.getFile(document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    const res = await axios.get(fileUrl, { responseType: "arraybuffer", timeout: 60000 });
    fs.writeFileSync(tmpPath, res.data);

    if (isTarGz) {
      await new Promise((resolve, reject) => {
        const child = spawn("tar", ["-xzf", tmpPath, "-C", extractDir]);
        let stderr = "";
        child.stderr.on("data", (d) => { stderr += d; });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar extract gagal: ${stderr}`))));
      });

      const sqlFile = path.join(extractDir, "db.sql");
      if (fs.existsSync(sqlFile)) {
        await restoreFromFile(sqlFile, user, db);
      }
      const wsDir = path.join(extractDir, "workspace");
      if (fs.existsSync(wsDir)) {
        fs.cpSync(wsDir, path.join(ROOT_DIR, "workspace"), { recursive: true, force: true });
      }
      for (const extraFile of ["scheduler_data.json", "webhooks.json", "config.json"]) {
        const extractedExtra = path.join(extractDir, extraFile);
        if (fs.existsSync(extractedExtra)) {
          fs.copyFileSync(extractedExtra, path.join(ROOT_DIR, extraFile));
        }
      }
    } else {
      await restoreFromFile(tmpPath, user, db);
    }

    // Konfigurasi bot (model/baseUrl/apiKey/fallbackModels) mungkin berubah mengikuti isi backup.
    await syncConfigFromDb();
    await replyText(
      msg,
      isTarGz
        ? "✅ *Full Restore selesai!* Database, seluruh folder `workspace/` (termasuk profil browser), jadwal, dan konfigurasi telah dipulihkan."
        : "✅ *Restore selesai.* Memori percakapan, konfigurasi bot, dan data akses user sudah diganti dengan isi backup."
    );
  } catch (err) {
    console.error("[Restore] gagal:", err.message);
    await replyText(
      msg,
      `❌ Restore gagal: ${err.message}\n\nDatabase bisa jadi baru ter-restore sebagian — perbaiki file lalu restore ulang, atau restore dari backup lain.`
    );
  } finally {
    fs.unlink(tmpPath, () => {});
    if (extractDir) fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

module.exports = { handleBackup, handleBackupFull, handleRestore };
