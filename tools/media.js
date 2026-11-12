/**
 * tools/media.js — Tool media: media_download, render_remotion_video, start_web_preview.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { startWebPreview } = require("../webPreviewManager.js");
const { queueRender } = require("../remotionManager.js");
const { sessionWorkspacePath } = require("../lib/paths");
const { assertPublicUrl, BlockedUrlError } = require("../lib/netGuard");
const { truncate, resolveFilePath } = require("./common");

/**
 * Mengambil metadata TikTok (termasuk kumpulan foto slide & video) dari TikWM API.
 */
function fetchJsonTikWM(tiktokUrl) {
  return new Promise((resolve, reject) => {
    const postData = `url=${encodeURIComponent(tiktokUrl)}`;
    const req = https.request("https://www.tikwm.com/api/", {
      method: "POST",
      family: 4,
      timeout: 15000,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Gagal parsing response TikWM: ${body.slice(0, 100)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("Timeout menghubungi TikWM API")); });
    req.write(postData);
    req.end();
  });
}

/**
 * Mengunduh file dari URL langsung ke path disk lokal (mengikuti redirect).
 */
function downloadFileToDisk(fileUrl, destPath, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error("Terlalu banyak redirect"));
  return new Promise((resolve, reject) => {
    const client = fileUrl.startsWith("https") ? https : http;
    const req = client.get(fileUrl, {
      family: 4,
      timeout: 30000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFileToDisk(res.headers.location, destPath, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} saat mengunduh file`));
      }
      const stream = fs.createWriteStream(destPath);
      res.pipe(stream);
      stream.on("finish", () => {
        stream.close(() => resolve(destPath));
      });
      stream.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("Timeout saat mengunduh file")); });
  });
}

/**
 * Menangani unduhan postingan TikTok khusus slide foto (atau fallback video).
 */
async function downloadTikTokMedia({ url, format, workspaceDir }) {
  const data = await fetchJsonTikWM(url);
  if (!data || data.code !== 0 || !data.data) {
    throw new Error(data?.msg || "Gagal mendapatkan data media dari TikTok API");
  }

  const d = data.data;
  const artifactsDir = path.join(workspaceDir, "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });

  const safeId = String(d.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "_");

  // A. Jika postingan berisi kumpulan foto slide:
  if (Array.isArray(d.images) && d.images.length > 0) {
    const downloadedImages = [];
    for (let i = 0; i < d.images.length; i++) {
      const imgUrl = d.images[i];
      if (!imgUrl) continue;
      const fileName = `tiktok_slide_${safeId}_${i + 1}.jpg`;
      const filePath = path.join(artifactsDir, fileName);
      try {
        await assertPublicUrl(imgUrl);
        await downloadFileToDisk(imgUrl, filePath);
        downloadedImages.push(fileName);
      } catch (imgErr) {
        console.warn(`[TikTok Slide] Gagal unduh slide ${i + 1}: ${imgErr.message}`);
      }
    }

    if (downloadedImages.length === 0) {
      throw new Error("Gagal mengunduh foto-foto slide TikTok.");
    }

    let musicName = null;
    if (d.music) {
      const mPath = path.join(artifactsDir, `tiktok_music_${safeId}.mp3`);
      try {
        await assertPublicUrl(d.music);
        await downloadFileToDisk(d.music, mPath);
        musicName = path.basename(mPath);
      } catch (_) {}
    }

    const listStr = downloadedImages.map((f, i) => `${i + 1}. /workspace/artifacts/${f}`).join("\n");
    const musicStr = musicName ? `\n• Musik pengiring: /workspace/artifacts/${musicName}` : "";

    return (
      `✅ Berhasil mengunduh ${downloadedImages.length} foto slide TikTok (Judul: "${(d.title || "TikTok Slide").slice(0, 50)}"):` +
      `\n\n${listStr}${musicStr}\n\n` +
      `Kirimkan foto-foto slide ini ke chat user menggunakan tool send_photo (file_path: "/workspace/artifacts/...").`
    );
  }

  // B. Jika postingan berupa video biasa (dipanggil saat yt-dlp gagal sebagai fallback):
  const videoUrl = d.play || d.wmplay || d.hdplay;
  if (videoUrl) {
    const safeTitle = (d.title || "tiktok")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_")
      .slice(0, 30);
    const videoFileName = `${safeTitle || "tiktok"}_${safeId}.mp4`;
    const videoFilePath = path.join(workspaceDir, videoFileName);
    await assertPublicUrl(videoUrl);
    await downloadFileToDisk(videoUrl, videoFilePath);
    const sandboxPath = `/workspace/${videoFileName}`;
    return `✅ Berhasil mengunduh media:\n${videoFileName}\n\nKirimkan file ini ke user menggunakan tool send_file dengan file_path "${sandboxPath}".`;
  }

  throw new Error("Tidak ditemukan stream video maupun foto pada postingan TikTok ini.");
}

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
  const trimmedUrl = url.trim();
  try {
    await assertPublicUrl(trimmedUrl);
  } catch (err) {
    if (err instanceof BlockedUrlError) return `⛔ ${err.message}`;
    throw err;
  }

  const workspaceDir = sessionWorkspacePath(sessionId);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const isTikTok = /tiktok\.com/i.test(trimmedUrl);
  const isPhotoRequest = format === "photo" || format === "slide" || format === "image" || /\/photo\//i.test(trimmedUrl);

  // Jika URL TikTok dan merupakan postingan foto/slide (atau diminta format photo):
  if (isTikTok && isPhotoRequest) {
    try {
      const tiktokResult = await downloadTikTokMedia({ url: trimmedUrl, format, workspaceDir });
      if (tiktokResult) return tiktokResult;
    } catch (ttErr) {
      console.warn(`[TikTok Extractor] Gagal via API: ${ttErr.message}, mencoba fallback ke yt-dlp...`);
    }
  }

  const outputTemplate = path.join(workspaceDir, "%(title).40s.%(ext)s");
  const startedAt = Date.now();

  try {
    const { stdout } = await runYtDlp(buildYtDlpArgs(trimmedUrl, format, outputTemplate));

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
    // Fallback TikTok: Jika yt-dlp gagal pada URL TikTok, coba ekstrak via TikWM (bisa jadi postingan foto slide atau video)
    if (isTikTok) {
      try {
        const tiktokResult = await downloadTikTokMedia({ url: trimmedUrl, format, workspaceDir });
        if (tiktokResult) return tiktokResult;
      } catch (ttFallbackErr) {
        console.warn(`[TikTok Fallback] Gagal: ${ttFallbackErr.message}`);
      }
    }

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
