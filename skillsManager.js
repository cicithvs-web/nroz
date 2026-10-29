/**
 * skillsManager.js — Sistem Manajemen Keahlian On-Demand (Ala Antigravity Skills)
 * 
 * Mengelola modul-modul skill eksternal di folder /root/nroz/skills/
 * Memungkinkan Base System Prompt tetap ramping dan hemat token, sementara
 * panduan teknis mendalam dimuat secara on-demand via tool `read_skill`.
 */

const fs = require("fs");
const path = require("path");

const SKILLS_DIR = path.join(__dirname, "skills");

/**
 * Membaca metadata (YAML frontmatter) dari file SKILL.md
 * @param {string} content - Konten teks file markdown
 * @param {string} fallbackName - Nama default jika tidak ditemukan frontmatter
 * @returns {{ name: string, description: string, body: string }}
 */
function parseSkillMetadata(content, fallbackName) {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    // Fallback: cari baris pertama atau judul
    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
    const title = lines[0] ? lines[0].replace(/^#+\s*/, "") : fallbackName;
    const desc = lines[1] || `Keahlian untuk ${fallbackName}`;
    return { name: fallbackName, description: desc, body: content };
  }

  const rawYaml = frontmatterMatch[1];
  const body = frontmatterMatch[2];

  let name = fallbackName;
  let description = "";

  const nameMatch = rawYaml.match(/^name:\s*(.+)$/m);
  if (nameMatch) name = nameMatch[1].trim();

  const descMatch = rawYaml.match(/^description:\s*(.+)$/m);
  if (descMatch) description = descMatch[1].trim();

  return { name, description, body };
}

/**
 * Memindai seluruh folder di /root/nroz/skills/ dan mendaftarkan skill yang valid
 * @returns {Map<string, { name: string, description: string, filePath: string }>}
 */
function discoverSkills() {
  const skillsMap = new Map();
  if (!fs.existsSync(SKILLS_DIR)) {
    return skillsMap;
  }

  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    const skillFilePath = path.join(SKILLS_DIR, skillName, "SKILL.md");

    if (fs.existsSync(skillFilePath)) {
      try {
        const content = fs.readFileSync(skillFilePath, "utf8");
        const meta = parseSkillMetadata(content, skillName);
        skillsMap.set(meta.name.toLowerCase(), {
          name: meta.name,
          description: meta.description,
          filePath: skillFilePath
        });
      } catch (err) {
        console.warn(`[SkillsManager] Gagal membaca skill '${skillName}':`, err.message);
      }
    }
  }

  return skillsMap;
}

/**
 * Cache in-memory untuk skill terdaftar
 */
let cachedSkills = null;

function getSkillsMap() {
  if (!cachedSkills) {
    cachedSkills = discoverSkills();
  }
  return cachedSkills;
}

/**
 * Mengembalikan daftar katalog skill terdaftar
 * @returns {Array<{ name: string, description: string }>}
 */
function listSkills() {
  const map = getSkillsMap();
  return Array.from(map.values()).map((s) => ({
    name: s.name,
    description: s.description
  }));
}

/**
 * Menghasilkan teks katalog untuk diinjeksikan ke dalam Base System Prompt
 * @returns {string}
 */
function getSkillsPromptIndex() {
  const skills = listSkills();
  if (skills.length === 0) return "";

  const lines = [
    "Katalog Keahlian Khusus (Skills):",
    "Kamu memiliki pustaka skill teknis mendalam. Jika tugas user membutuhkan salah satu keahlian ini, " +
      "KAMU BISA MEMBACA PANDUAN LENGKAPNYA menggunakan tool `read_skill({ skill_name: \"...\" })` sebelum mengeksekusi:",
  ];

  for (const s of skills) {
    lines.push(`- \`${s.name}\`: ${s.description}`);
  }

  return lines.join("\n");
}

/**
 * Mencari dan membaca isi file SKILL.md untuk nama skill tertentu
 * Mendukung pencarian toleran / alias
 * @param {string} queryName
 * @returns {string}
 */
function readSkill(queryName) {
  if (!queryName || typeof queryName !== "string") {
    return "❌ Parameter 'skill_name' wajib diisi.";
  }

  const clean = queryName.trim().toLowerCase().replace(/[^a-z0-9_\-]/g, "");
  const map = getSkillsMap();

  // 1. Cek pencocokan persis
  if (map.has(clean)) {
    const s = map.get(clean);
    return fs.readFileSync(s.filePath, "utf8");
  }

  // 2. Cek alias / substring
  for (const [key, val] of map.entries()) {
    if (key.includes(clean) || clean.includes(key)) {
      return fs.readFileSync(val.filePath, "utf8");
    }
  }

  // 3. Sinonim umum
  if (clean.includes("video") || clean.includes("remotion")) {
    if (map.has("remotion_video")) return fs.readFileSync(map.get("remotion_video").filePath, "utf8");
  }
  if (clean.includes("gambar") || clean.includes("image") || clean.includes("foto") || clean.includes("photo")) {
    if (map.has("image_generation")) return fs.readFileSync(map.get("image_generation").filePath, "utf8");
  }
  if (clean.includes("subagent") || clean.includes("orkestrasi") || clean.includes("orchestrat")) {
    if (map.has("subagent_orchestration")) return fs.readFileSync(map.get("subagent_orchestration").filePath, "utf8");
  }
  if (clean.includes("preview") || clean.includes("web") || clean.includes("tunnel") || clean.includes("cloudflare")) {
    if (map.has("web_preview")) return fs.readFileSync(map.get("web_preview").filePath, "utf8");
  }

  const available = Array.from(map.keys()).join(", ");
  return `❌ Skill '${queryName}' tidak ditemukan dalam pustaka. Skill yang tersedia: [${available}]. Gunakan salah satu nama tersebut.`;
}

module.exports = {
  discoverSkills,
  listSkills,
  getSkillsPromptIndex,
  readSkill
};
