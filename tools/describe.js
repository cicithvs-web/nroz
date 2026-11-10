/**
 * tools/describe.js — Ringkasan satu baris tiap tool call untuk draft progres di Telegram.
 */

const path = require("path");

/**
 * Ringkasan satu baris yang aman ditampilkan ke user: bukan dump argumen, tapi apa yang
 * sebenarnya sedang dikerjakan. Nilai yang terlihat seperti secret disamarkan.
 */
function describeToolCall(name, args = {}) {
  // Draft Telegram dikirim tanpa parse_mode, jadi karakter asli (underscore nama file,
  // tanda kutip, path) boleh dan justru harus ditampilkan apa adanya.
  const oneLine = (text, max = 90, fallback = "...") => {
    const bersih = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max).trim();
    return bersih || fallback;
  };

  const maskSecret = (text) =>
    oneLine(text, 4000)
      .replace(/(["']?(api[_-]?key|token|secret|password|authorization)["']?)\s*[:=]\s*["']?[^\s,"'}]+/gi, "$1:***");

  switch (name) {
    case "run_command": {
      const cmd = oneLine(maskSecret(args.command), 90, "perintah");
      return `menjalankan \`${cmd}\`${args.background ? " (latar belakang)" : ""}`;
    }
    case "check_command_output":
      return `mengecek output job ${oneLine(args.job_id, 20, "semua")}`;
    case "wait_command_output":
      return `menunggu job ${oneLine(args.job_id, 20, "?")} selesai`;
    case "run_code": {
      const firstLine = oneLine(
        String(args.code || "")
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith("//") && !l.startsWith("#") && !l.startsWith("/*")) || "",
        70
      );
      return `menjalankan ${oneLine(args.language || "kode", 12)}: ${firstLine}`;
    }
    case "web_search":
      return `mencari "${oneLine(args.query, 70)}"`;
    case "read_url":
      return `membaca ${oneLine(args.url, 70)}`;
    case "http_request":
      return `${oneLine((args.method || "GET").toUpperCase(), 8)} ${oneLine(args.url, 70)}`;
    case "file_read":
      return `membaca ${oneLine(path.basename(args.path || ""), 40)}`;
    case "file_write":
      return `menulis ${oneLine(path.basename(args.path || ""), 40)} (${Buffer.byteLength(String(args.content || ""))} byte)`;
    case "file_edit": {
      const count = Array.isArray(args.edits) ? ` (${args.edits.length} blok)` : "";
      return `mengedit bagian ${oneLine(path.basename(args.path || ""), 40)}${count}`;
    }
    case "workspace_undo":
      return args.action === "list"
        ? "melihat riwayat snapshot undo"
        : `membatalkan perubahan file ${args.path ? oneLine(path.basename(args.path), 30) : "terakhir"}`;
    case "file_list":
      return `daftar isi ${oneLine(args.path || ".", 40)}`;
    case "code_search":
      return `mencari kode "${oneLine(args.query, 45)}"${args.file_pattern ? ` (${oneLine(args.file_pattern, 15)})` : ""}`;
    case "system_info":
      return "mengecek kondisi server";
    case "start_web_preview":
      return `membuka preview web di port ${oneLine(args.port, 6)}`;
    case "create_reminder": {
      const kapan = args.at
        ? `pada ${oneLine(args.at, 20)}`
        : `${oneLine(args.minutes_from_now, 6)} menit lagi`;
      const ulang = args.repeat && args.repeat !== "none" ? ` (${oneLine(args.repeat, 10)})` : "";
      return `menjadwalkan pengingat ${kapan}${ulang}: ${oneLine(args.message, 50)}`;
    }
    case "create_watchdog":
      return `memantau ${oneLine(args.url, 60)}${args.auto_heal_task ? " (self-healing)" : ""}`;
    case "schedule_agent_task": {
      const kapan = args.at
        ? `pada ${oneLine(args.at, 20)}`
        : `${oneLine(args.minutes_from_now, 6)} menit lagi`;
      const ulang = args.repeat && args.repeat !== "none" ? ` (${oneLine(args.repeat, 10)})` : "";
      return `menjadwalkan tugas otonom ${kapan}${ulang}: ${oneLine(args.task, 50)}`;
    }
    case "search_knowledge":
      return `mencari semantik "${oneLine(args.query, 50)}"${args.source ? ` di ${oneLine(args.source, 20)}` : ""}`;
    case "save_knowledge":
      return `menyimpan pengetahuan "${oneLine(args.title || "catatan", 45)}" ke memori semantik`;
    case "ask_user":
      return `bertanya ke user: "${oneLine(args.question, 60)}"${Array.isArray(args.options) && args.options.length ? ` (${args.options.length} opsi)` : ""}`;
    case "analyze_video_reference":
      return `menganalisis gaya video referensi ${oneLine(path.basename(args.video_path || ""), 30)}`;
    case "media_download":
      return `mengunduh media dari ${oneLine(args.url, 70)}`;
    case "render_remotion_video": {
      const bagian = [];
      if (args.title) bagian.push(oneLine(args.title, 30));
      if (args.duration_seconds) bagian.push(`${args.duration_seconds}s`);
      if (args.fps) bagian.push(`${args.fps}fps`);
      if (args.tts_lines?.length) bagian.push(`${args.tts_lines.length} baris naskah`);
      else if (args.tts_text) bagian.push(`${oneLine(args.tts_text, 24)}...`);
      return `merender video ${bagian.join(" · ") || "(tanpa judul)"}`;
    }
    case "record_decision":
      return `mencatat keputusan: "${oneLine(args.decision, 60)}"`;
    case "forget_decision":
      return `mencabut keputusan #${args.id ?? "?"}`;
    case "update_project_context":
      return `memperbarui status proyek: "${oneLine(args.summary, 60)}"`;
    case "search_raw_memory":
      return `mencari arsip obrolan "${oneLine(args.query, 40)}"`;
    case "delegate_task":
      return `mendelegasikan ke subagent ${oneLine(args.role || "coder", 12)}: "${oneLine(args.task, 50)}"`;
    case "delegate_parallel_tasks": {
      const list = Array.isArray(args.tasks) ? args.tasks : [];
      const roles = list.map((t) => oneLine(t?.role || "agent", 12)).join(", ");
      return `menjalankan ${list.length} subagent paralel (${roles || "swarm"})`;
    }
    case "send_photo":
      return `mengirim foto ${oneLine(path.basename(args.file_path || ""), 30)} ke Telegram`;
    case "send_file":
      return `mengirim file ${oneLine(path.basename(args.file_path || ""), 30)} ke Telegram`;
    case "read_skill":
      return `mempelajari panduan skill \`${args.skill_name || ""}\``;
    case "save_skill":
      return `merekam keahlian baru: ${oneLine(args.name || "", 30)}`;
    default: {
      if (name === "sequentialthinking" || name === "sequential_thinking") {
        const step = args.thoughtNumber ? ` (langkah ${args.thoughtNumber}/${args.totalThoughts || '?'})` : "";
        const preview = args.thought ? `: "${oneLine(args.thought, 40)}"` : "";
        return `berpikir mendalam${step}${preview}`;
      }
      if (name.startsWith("browser_")) {
        if (name === "browser_navigate") return `membuka web ${oneLine(args.url || "", 50)}`;
        if (name === "browser_take_screenshot") return "mengambil screenshot layar web";
        if (name === "browser_click") return `mengklik elemen di web (${oneLine(args.selector || "", 30)})`;
        if (name === "browser_type") return `mengetik teks di web (${oneLine(args.selector || "", 25)})`;
        if (name === "browser_fill_form") return "mengisi form di halaman web";
        if (name === "browser_snapshot") return "memeriksa struktur elemen halaman web";
        if (name === "browser_wait_for") return "menunggu halaman web merespon";
        return `menjalankan browser: ${name.replace("browser_", "")}`;
      }
      return oneLine(maskSecret(`${name} ${JSON.stringify(args)}`), 90, name);
    }
  }
}


module.exports = { describeToolCall };
