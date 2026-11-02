/**
 * tools/media.js — Tool media: media_download, render_remotion_video, start_web_preview.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { startWebPreview } = require("../webPreviewManager.js");
const { queueRender } = require("../remotionManager.js");
const { sessionWorkspacePath } = require("../lib/paths");
const { assertPublicUrl, BlockedUrlError } = require("../lib/netGuard");
const { truncate, resolveFilePath } = require("./common");

/**
 * Argumen yt-dlp sebagai array (dijalankan dengan execFile, tanpa shell), jadi URL dari
 * model tidak bisa menyisipkan perintah seperti `"; rm -rf ~; "` atau `$(...)`.
 * "--" memastikan URL yang diawali "-" tidak dibaca sebagai opsi.
 */
function buildYtDlpArgs(url, format, outputTemplate) {
  const isAudio = format === "audio" || format === "mp3";
  const formatArgs = isAudio ? ["-x", "--audio-format", "mp3"] : ["-f", "best[ext=mp4]/best"];
  return [
    ...formatArgs,
    "--max-filesize", "45M",
    "--no-simulate",
    "--print", "after_move:filepath",
    "-o", outputTemplate,
    "--",
    url
  ];
}

function runYtDlp(args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    execFile("yt-dlp", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Tool: media_download
 */
async function toolMediaDownload({ url, format = "video", sessionId }) {
  if (!url || typeof url !== "string") return "❌ 'url' wajib diisi.";
  try {
    await assertPublicUrl(url.trim());
  } catch (err) {
    if (err instanceof BlockedUrlError) return `⛔ ${err.message}`;
    throw err;
  }

  const workspaceDir = sessionWorkspacePath(sessionId);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const outputTemplate = path.join(workspaceDir, "%(title).40s.%(ext)s");
  const startedAt = Date.now();

  try {
    const { stdout } = await runYtDlp(buildYtDlpArgs(url.trim(), format, outputTemplate));

    // yt-dlp mencetak path final; kalau tidak ada, cari file terbaru di workspace.
    let downloadedFile = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    if (!downloadedFile || !fs.existsSync(downloadedFile)) {
      downloadedFile = "";
      let newestTime = startedAt - 5000;
      for (const item of fs.readdirSync(workspaceDir)) {
        const p = path.join(workspaceDir, item);
        try {
          const st = fs.lstatSync(p);
          if (st.isFile() && st.mtimeMs > newestTime) {
            newestTime = st.mtimeMs;
            downloadedFile = p;
          }
        } catch (_) {}
      }
    }

    if (downloadedFile) {
      const sandboxPath = `/workspace/${path.basename(downloadedFile)}`;
      return `✅ Berhasil mengunduh media:\n${path.basename(downloadedFile)}\n\nKirimkan file ini ke user menggunakan tool send_file dengan file_path "${sandboxPath}".`;
    }
    return `✅ Selesai:\n${truncate(stdout)}`;
  } catch (err) {
    if (err.killed) return "⏱️ Unduhan dihentikan karena melebihi 120 detik.";
    const stderr = err.stderr ? err.stderr.toString() : "";
    return truncate(`❌ Gagal mengunduh media: ${stderr || err.message}`);
  }
}

/**
 * Tool: start_web_preview
 */
async function toolStartWebPreview({ port, duration_minutes, sessionId }) {
  try {
    const url = await startWebPreview(port, duration_minutes || 30, { sessionId });
    return `🌐 Link Web Preview Publik Aktif:\n🔗 ${url}\n\nLink ini dapat langsung dibuka di browser mana saja (aktif selama ${duration_minutes || 30} menit).`;
  } catch (err) {
    return `❌ Gagal membuat web preview: ${err.message}`;
  }
}

/**
 * Tool: render_remotion_video
 */
async function toolRenderRemotionVideo({ code, duration_seconds, fps, width, height, title, sessionId, tts_text, tts_lines, tts_voice, audio_path, chatId, threadId }) {
  if (!code || typeof code !== "string") {
    return "❌ Parameter 'code' (kode React/Remotion) wajib diisi.";
  }

  let narration = tts_lines;
  if (typeof narration === "string") {
    try {
      narration = JSON.parse(narration);
    } catch (_) {
      return "❌ Parameter 'tts_lines' tidak bisa dibaca. Kirim sebagai array objek: [{\"text\":\"...\",\"voice\":\"id-female\"}]";
    }
  }
  if (narration && !Array.isArray(narration)) {
    return "❌ Parameter 'tts_lines' harus berupa array baris naskah.";
  }

  let catatanAudio = "";
  if (audio_path) {
    const guard = resolveFilePath(String(audio_path).trim(), sessionId || "default");
    if (!guard.ok) return `⛔ audio_path ditolak: ${guard.error}`;
    const hostAudio = guard.path;
    if (!fs.existsSync(hostAudio) || !fs.statSync(hostAudio).isFile()) {
      return (
        `❌ audio_path "${audio_path}" tidak ditemukan.\n` +
        `File harus ada di folder kerjamu: taruh sebagai /workspace/${path.basename(hostAudio)} ` +
        `(run_command/file_write hanya menulis ke sandbox kalau path dimulai /workspace), lalu panggil render lagi.\n` +
        `Kalau yang dimaksud adalah suara narasi, pakai tts_text atau tts_lines saja — sistem yang membuat audionya.`
      );
    }
    if ((tts_text && String(tts_text).trim()) || (narration && narration.length)) {
      catatanAudio = "\n• Catatan: audio_path diabaikan karena voiceover TTS dipakai; suara AI yang masuk ke video.";
    }
    audio_path = hostAudio;
  }

  const { job, position } = queueRender(
    {
      code,
      durationSeconds: duration_seconds,
      fps,
      width,
      height,
      title,
      sessionId: sessionId || "default",
      tts_text,
      tts_lines: narration,
      tts_voice,
      audio_path
    },
    { chatId, threadId }
  );

  const estimasiMenit = Math.max(1, Math.round((job.estimateSec + job.waitSec) / 60));
  const catatanAntrean = position > 1 ? `\n• Posisi antrean: ${position} (render sebelumnya masih berjalan)` : "";
  const catatanNarasi = narration && narration.length ? `\n• Voiceover: ${narration.length} baris naskah, durasi video mengikuti panjang suara (progres di chat memakai durasi sebenarnya)` : "";

  return (
    `⏳ Render video #${job.id} dimulai di latar belakang.\n` +
    `• Judul: ${title || "video"}\n` +
    `• Durasi: ${job.duration} detik (${job.frames} frame${duration_seconds > job.duration ? `, diminta ${duration_seconds}s tapi dipangkas ke batas maksimum` : ""})${catatanNarasi}\n` +
    `• Estimasi selesai: ±${estimasiMenit} menit${catatanAntrean}${catatanAudio}\n\n` +
    `PENTING: Video akan DIKIRIM OTOMATIS oleh sistem ke chat ini saat render selesai.\n` +
    `Selama rendering, sistem menampilkan satu pesan progres (persen, jumlah frame, sisa waktu) yang di-update sendiri — ` +
    `bilang saja ke user bahwa progresnya bisa dipantau di chat, jangan membuat pesan progres sendiri.\n` +
    `Hasil ≤ 48 MB masuk sebagai video native; yang lebih besar dikirim otomatis sebagai link unduhan HTTPS — ` +
    `jadi JANGAN mengompres ulang, menurunkan bitrate, atau memecah video supaya muat 50 MB.\n` +
    `Jangan menunggu hasil, jangan render ulang kode yang sama, dan jangan pakai tag <<<SENDVIDEO>>>.\n` +
    `Cukup kabari user bahwa videonya sedang dikerjakan, lalu akhiri jawabanmu.`
  );
}

module.exports = {
  buildYtDlpArgs,
  toolMediaDownload,
  toolStartWebPreview,
  toolRenderRemotionVideo
};
