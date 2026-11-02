/**
 * bot/fileDelivery.js — Mengirim file yang diminta jawaban AI (tag <<<SENDFILE/SENDPHOTO/SENDVIDEO>>>,
 * <<<FILE>>>/code block jadi dokumen atau ZIP).
 *
 * Tag dikirim oleh model, dan model bisa dipengaruhi prompt injection dari halaman web,
 * jadi path dari tag hanya boleh menunjuk file di workspace sesi (lib/pathGuard.js).
 */

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const ctx = require("./context");
const { getSessionId } = require("./access");
const { getChatWorkspace } = require("./workspace");
const { extractFilesFromAnswer, extractZipName } = require("./fileExtract");
const { resolveInWorkspace } = require("../lib/pathGuard");

/**
 * Menerjemahkan path dari model (/workspace/..., path host workspace, atau relatif) ke path host
 * di dalam workspace sesi. Kalau tidak ketemu, dicoba juga di artifacts/ dengan nama yang sama.
 * @returns {string} path host, atau "" kalau path berada di luar workspace / tidak ada
 */
function resolveToHost(rawPath, sessionId) {
  if (!rawPath || typeof rawPath !== "string") return "";
  const userWs = getChatWorkspace(sessionId);
  const primary = resolveInWorkspace(rawPath.trim(), sessionId);
  if (!primary.ok) {
    console.warn(`[File Delivery] Path ditolak (${rawPath}): ${primary.error}`);
    return "";
  }
  if (fs.existsSync(primary.path)) return primary.path;

  const inArtifacts = resolveInWorkspace(path.join(userWs, "artifacts", path.basename(rawPath.trim())), sessionId);
  if (inArtifacts.ok && fs.existsSync(inArtifacts.path)) return inArtifacts.path;

  return primary.path;
}

async function sendTaggedFiles(kind, regex, rawAnswer, sessionId, chatId, sendOpts, turnMediaSent) {
  const bot = ctx.bot;
  for (const match of rawAnswer.matchAll(regex)) {
    const targetPath = resolveToHost(match[1].trim(), sessionId);
    if (!targetPath) continue;
    try {
      if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) continue;
      const fileName = path.basename(targetPath);
      if (kind === "file") {
        await bot.sendDocument(chatId, targetPath, { caption: `📦 File dari Server: ${fileName}`, ...sendOpts });
        turnMediaSent.files++;
      } else if (kind === "photo") {
        await bot.sendPhoto(chatId, targetPath, { caption: `🖼️ Gambar / Visual: ${fileName}`, ...sendOpts });
        turnMediaSent.photos++;
      } else {
        await bot.sendVideo(chatId, targetPath, {
          caption: `🎬 Video Dibuat: ${fileName}`,
          supports_streaming: true,
          ...sendOpts
        });
      }
    } catch (err) {
      console.error(`[Send${kind} Error] Gagal kirim ${targetPath}:`, err.message);
    }
  }
}

/** Gambar terbaru (3 menit terakhir) di artifacts/ atau root workspace; symlink dilewati. */
function findRecentImage(userWs) {
  const imageExts = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
  const MAX_IMAGE_AGE_MS = 3 * 60 * 1000;
  const now = Date.now();
  let newestImage = null;
  let newestMtime = 0;

  for (const dir of [path.join(userWs, "artifacts"), userWs]) {
    let files;
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) continue;
      files = fs.readdirSync(dir);
    } catch (_) {
      continue;
    }
    for (const file of files) {
      const full = path.join(dir, file);
      try {
        const st = fs.lstatSync(full);
        if (st.isFile() && imageExts.has(path.extname(file).toLowerCase())) {
          if (now - st.mtimeMs < MAX_IMAGE_AGE_MS && st.mtimeMs > newestMtime) {
            newestMtime = st.mtimeMs;
            newestImage = full;
          }
        }
      } catch (_) {}
    }
  }
  return newestImage;
}

async function handleGeneratedFiles(chatId, msg, rawAnswer, userPrompt, turnMediaSent = { photos: 0, files: 0 }) {
  const bot = ctx.bot;
  try {
    const sendOpts = {};
    if (msg.message_thread_id) sendOpts.message_thread_id = msg.message_thread_id;
    const sessionId = getSessionId(msg);
    const userWs = getChatWorkspace(sessionId);

    // 1. Tag kiriman file fisik dari workspace
    await sendTaggedFiles("file", /<<<SENDFILE:\s*([^\n>]+)>>>/gi, rawAnswer, sessionId, chatId, sendOpts, turnMediaSent);
    await sendTaggedFiles("photo", /<<<(?:SENDPHOTO|SENDIMAGE):\s*([^\n>]+)>>>/gi, rawAnswer, sessionId, chatId, sendOpts, turnMediaSent);
    await sendTaggedFiles("video", /<<<SENDVIDEO:\s*([^\n>]+)>>>/gi, rawAnswer, sessionId, chatId, sendOpts, turnMediaSent);

    // 2. Fallback: user minta gambar tapi belum ada foto yang terkirim di giliran ini
    if (turnMediaSent.photos === 0) {
      const isImageIntent = /\b(gambar|foto|lukis|image|photo|draw|chart|grafik|ilustrasi|diagram)\b/i.test(userPrompt || "");
      const newestImage = isImageIntent ? findRecentImage(userWs) : null;
      if (newestImage) {
        console.log(`[AutoImageDelivery] Mengirimkan gambar terbaru hasil buatan AI ke chat: ${newestImage}`);
        try {
          await bot.sendPhoto(chatId, newestImage, { caption: `🖼️ Hasil Gambar: ${path.basename(newestImage)}`, ...sendOpts });
          turnMediaSent.photos++;
        } catch (autoErr) {
          console.error(`[AutoImageDelivery Error] Gagal kirim foto ${newestImage}:`, autoErr.message);
        }
      }
    }

    // 3. File atau ZIP yang di-generate langsung dari AI code block
    const generatedFiles = extractFilesFromAnswer(rawAnswer, userPrompt);
    if (!generatedFiles || generatedFiles.length === 0) return;

    const wantsZip = /jadikan.*zip|buatkan.*zip|\.zip\b|arsip/i.test(userPrompt || "") || /<<<ZIP:/i.test(rawAnswer);

    if (generatedFiles.length === 1 && !wantsZip) {
      const f = generatedFiles[0];
      await bot.sendDocument(
        chatId,
        Buffer.from(f.content, "utf8"),
        { caption: `📄 File dibuat: ${f.filename}`, ...sendOpts },
        { filename: path.basename(f.filename), contentType: "application/octet-stream" }
      );
    } else {
      // Kumpulan file dalam ZIP (mendukung struktur folder seperti public/index.html)
      const zipName = extractZipName(rawAnswer, userPrompt);
      const zip = new AdmZip();
      for (const f of generatedFiles) zip.addFile(f.filename, Buffer.from(f.content, "utf8"));
      const fileList = generatedFiles.map((f) => `• ${f.filename}`).join("\n");
      await bot.sendDocument(
        chatId,
        zip.toBuffer(),
        { caption: `📦 File ZIP dibuat: ${zipName}\n\nDaftar isi file & folder:\n${fileList}`.slice(0, 1024), ...sendOpts },
        { filename: zipName, contentType: "application/zip" }
      );
    }
  } catch (err) {
    console.error("[File Generation Error] Gagal mengirim file/zip:", err.message);
  }
}

module.exports = { resolveToHost, handleGeneratedFiles };
