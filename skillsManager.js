/**
 * skillsManager.js — Sistem Manajemen Keahlian On-Demand Dua Tingkat (Two-Tier Skills)
 * 
 * 1. Global Skills: Berada di /root/nroz/skills/<name>/SKILL.md (bawaan sistem, berlaku global).
 * 2. Workspace Skills: Berada di /root/nroz/workspace/<sessionId>/skills/<name>/SKILL.md
 *    (keahlian hasil belajar/self-evolving khusus per user / workspace).
 */

const fs = require("fs");
const path = require("path");

const GLOBAL_SKILLS_DIR = path.join(__dirname, "skills");
const WORKSPACE_BASE = path.join(__dirname, "workspace");

/**
 * Mendapatkan direktori folder skill khusus untuk sesi/workspace tertentu
 */
function getWorkspaceSkillsDir(sessionId) {
  if (!sessionId) return null;
  return path.join(WORKSPACE_BASE, String(sessionId), "skills");
}

/**
 * Membaca metadata (YAML frontmatter) dari file SKILL.md
 * @param {string} content - Konten teks file markdown
 * @param {string} fallbackName - Nama default jika tidak ditemukan frontmatter
 * @returns {{ name: string, description: string, body: string }}
 */
function parseSkillMetadata(content, fallbackName) {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!frontmatterMatch) {
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
 * Memindai skill di direktori tertentu
 */
function scanSkillsFromDir(dirPath, scope = "global", sessionId = null) {
  const skillsMap = new Map();
  if (!dirPath || !fs.existsSync(dirPath)) {
    return skillsMap;
  }

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillName = entry.name;
      const skillFilePath = path.join(dirPath, skillName, "SKILL.md");

      if (fs.existsSync(skillFilePath)) {
        try {
          const content = fs.readFileSync(skillFilePath, "utf8");
          const meta = parseSkillMetadata(content, skillName);
          skillsMap.set(meta.name.toLowerCase(), {
            name: meta.name,
            description: meta.description,
            filePath: skillFilePath,
            scope,
            sessionId
          });
        } catch (err) {
          console.warn(`[SkillsManager] Gagal membaca skill '${skillName}' di ${dirPath}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.warn(`[SkillsManager] Gagal memindai folder ${dirPath}:`, err.message);
  }

  return skillsMap;
}

/**
 * Cache in-memory untuk global skills
 */
let cachedGlobalSkills = null;

function getGlobalSkillsMap() {
  if (!cachedGlobalSkills) {
    cachedGlobalSkills = scanSkillsFromDir(GLOBAL_SKILLS_DIR, "global");
  }
  return cachedGlobalSkills;
}

/**
 * Mengembalikan map seluruh skill untuk sesi tertentu (Global + Workspace)
 */
function getSkillsMap(sessionId = null) {
  const combined = new Map();

  // 1. Masukkan skill global
  const globals = getGlobalSkillsMap();
  for (const [k, v] of globals.entries()) {
    combined.set(k, v);
  }

  // 2. Masukkan skill khusus workspace user (jika ada)
  if (sessionId) {
    const wsDir = getWorkspaceSkillsDir(sessionId);
    if (wsDir && fs.existsSync(wsDir)) {
      const userSkills = scanSkillsFromDir(wsDir, "workspace", sessionId);
      for (const [k, v] of userSkills.entries()) {
        // Workspace skill bisa menimpa atau melengkapi global skill
        combined.set(k, v);
      }
    }
  }

  return combined;
}

/**
 * Mengembalikan daftar katalog skill terdaftar
 */
function listSkills(sessionId = null) {
  const map = getSkillsMap(sessionId);
  return Array.from(map.values()).map((s) => ({
    name: s.name,
    description: s.description,
    scope: s.scope || "global",
    filePath: s.filePath
  }));
}

/**
 * Menghasilkan teks katalog untuk diinjeksikan ke dalam Base System Prompt
 */
function getSkillsPromptIndex(sessionId = null) {
  const allSkills = listSkills(sessionId);
  if (allSkills.length === 0) return "";

  const globals = allSkills.filter((s) => s.scope !== "workspace");
  const userLearned = allSkills.filter((s) => s.scope === "workspace");

  const lines = [
    "Katalog Keahlian Khusus (Skills):",
    "Kamu memiliki pustaka skill teknis mendalam. Jika tugas user membutuhkan salah satu keahlian ini, " +
      "KAMU BISA MEMBACA PANDUAN LENGKAPNYA menggunakan tool `read_skill({ skill_name: \"...\" })` sebelum mengeksekusi:",
  ];

  if (globals.length > 0) {
    lines.push("\n[Keahlian Bawaan Sistem]:");
    for (const s of globals) {
      lines.push(`- \`${s.name}\`: ${s.description}`);
    }
  }

  if (userLearned.length > 0) {
    lines.push("\n[Keahlian Khusus Hasil Belajar (Workspace)]: ");
    for (const s of userLearned) {
      lines.push(`- \`${s.name}\` (Skill Pribadi): ${s.description}`);
    }
  }

  return lines.join("\n");
}

/**
 * Mencari dan membaca isi file SKILL.md untuk nama skill tertentu
 * Mendukung prioritas workspace -> global, serta toleransi pencarian alias
 */
function readSkill(queryName, sessionId = null) {
  if (!queryName || typeof queryName !== "string") {
    return "❌ Parameter 'skill_name' wajib diisi.";
  }

  const clean = queryName.trim().toLowerCase().replace(/[^a-z0-9_\-]/g, "");
  const map = getSkillsMap(sessionId);

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

  // 3. Sinonim umum untuk skill global
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
  if (clean.includes("browser") || clean.includes("playwright") || clean.includes("screenshot")) {
    if (map.has("browser_automation")) return fs.readFileSync(map.get("browser_automation").filePath, "utf8");
  }
  if (clean.includes("think") || clean.includes("sequential") || clean.includes("nalar")) {
    if (map.has("sequential_thinking")) return fs.readFileSync(map.get("sequential_thinking").filePath, "utf8");
  }

  const available = Array.from(map.keys()).join(", ");
  return `❌ Skill '${queryName}' tidak ditemukan dalam pustaka. Skill yang tersedia: [${available}]. Gunakan salah satu nama tersebut.`;
}

/**
 * Menyimpan atau memperbarui keahlian baru di workspace pengguna
 */
function saveUserSkill(sessionId, { name, description, content }) {
  if (!sessionId) {
    throw new Error("SessionId wajib diisi untuk menyimpan workspace skill.");
  }
  if (!name || typeof name !== "string") {
    throw new Error("Nama skill wajib berupa string.");
  }
  if (!content || typeof content !== "string") {
    throw new Error("Konten panduan skill wajib diisi.");
  }

  const cleanName = String(name).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/_+/g, "_");
  const cleanDesc = description ? String(description).trim() : `Keahlian khusus untuk ${cleanName}`;

  const wsSkillsDir = getWorkspaceSkillsDir(sessionId);
  const targetDir = path.join(wsSkillsDir, cleanName);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Siapkan format SKILL.md dengan frontmatter rapi
  let fileContent = "";
  const trimmed = content.trim();
  if (trimmed.startsWith("---")) {
    fileContent = trimmed;
  } else {
    fileContent = `---
name: ${cleanName}
description: ${cleanDesc}
---

${trimmed}
`;
  }

  const targetFile = path.join(targetDir, "SKILL.md");
  fs.writeFileSync(targetFile, fileContent, "utf8");

  return {
    success: true,
    name: cleanName,
    description: cleanDesc,
    filePath: targetFile
  };
}

module.exports = {
  discoverSkills: getSkillsMap,
  listSkills,
  getSkillsPromptIndex,
  readSkill,
  saveUserSkill,
  getWorkspaceSkillsDir
};
