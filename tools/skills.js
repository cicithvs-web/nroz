/**
 * tools/skills.js — Tool katalog keahlian: read_skill, save_skill.
 */

const skillsManager = require("../skillsManager.js");

/**
 * Tool: read_skill
 * Membaca panduan teknis mendalam untuk keahlian tertentu dari katalog skill
 */
async function toolReadSkill({ skill_name, sessionId }) {
  if (!skill_name) return "❌ Parameter 'skill_name' wajib diisi.";
  return skillsManager.readSkill(skill_name, sessionId);
}

/**
 * Tool: save_skill
 * Menyimpan keahlian/SOP baru hasil belajar ke folder skill khusus workspace
 */
async function toolSaveSkill({ name, description, content, sessionId }) {
  if (!name || typeof name !== "string") {
    return "❌ Parameter 'name' wajib berupa string identitas skill.";
  }
  if (!content || typeof content !== "string") {
    return "❌ Parameter 'content' panduan skill wajib diisi.";
  }
  const desc = description || `Keahlian khusus untuk ${name}`;
  try {
    const res = skillsManager.saveUserSkill(sessionId || "default", {
      name,
      description: desc,
      content
    });
    return (
      `✅ Keahlian baru '${res.name}' berhasil dipelajari dan disimpan!\n` +
      `• Path: /workspace/skills/${res.name}/SKILL.md\n` +
      `• Deskripsi: ${res.description}\n` +
      `Keahlian ini sekarang otomatis aktif di katalog skill-mu dan bisa dipanggil kapan saja dengan read_skill({"skill_name": "${res.name}"}).`
    );
  } catch (err) {
    return `❌ Gagal menyimpan skill: ${err.message}`;
  }
}

module.exports = { toolReadSkill, toolSaveSkill };
