/**
 * tools/system.js — Tool system_info (kondisi CPU, RAM, disk VPS).
 */

const { execSync } = require("child_process");
const os = require("os");
const { truncate } = require("./common");

/**
 * Tool: system_info
 * Mengumpulkan informasi sistem VPS menggunakan modul os dan child_process.
 */
async function toolSystemInfo() {
  try {
    const uptime = os.uptime();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // Format bytes ke human-readable
    const fmt = (bytes) => {
      const gb = bytes / (1024 ** 3);
      return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / (1024 ** 2)).toFixed(2)} MB`;
    };

    // Ambil info disk dengan df -h
    let diskInfo = "(tidak tersedia)";
    try {
      diskInfo = execSync("df -h --total 2>/dev/null || df -h", {
        timeout: 5000,
        encoding: "utf-8",
      }).trim();
    } catch (e) {
      diskInfo = `(error: ${e.message})`;
    }

    // CPU info
    const cpus = os.cpus();
    const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : "(tidak diketahui)";

    // Load average
    const loadAvg = os.loadavg().map((v) => v.toFixed(2)).join(", ");

    const info = [
      `🖥️  Hostname  : ${os.hostname()}`,
      `💻  OS        : ${os.type()} ${os.release()} (${os.arch()})`,
      `⏱️  Uptime    : ${hours} jam ${mins} menit`,
      `🧠  CPU       : ${cpuModel} (${cpus.length} core)`,
      `📊  Load Avg  : ${loadAvg}`,
      `💾  Memori    : ${fmt(usedMem)} / ${fmt(totalMem)} (free: ${fmt(freeMem)})`,
      ``,
      `📁  Disk:`,
      diskInfo,
    ].join("\n");

    return truncate(info);
  } catch (err) {
    return `❌ Gagal mengambil info sistem: ${err.message}`;
  }
}

module.exports = { toolSystemInfo };
