-- Skema PostgreSQL untuk nroz-ai-bot.
-- Dijalankan otomatis oleh dbHelper.js saat pertama kali terhubung,
-- bisa juga dijalankan manual: psql "$DATABASE_URL" -f schema.sql

-- 1 dokumen = 1 pesan (user / assistant)
CREATE TABLE IF NOT EXISTS chat_memory (
  id TEXT PRIMARY KEY,               -- "<chat_id>_<telegram_message_id>" atau "<chat_id>_x<ts>"
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  ts BIGINT NOT NULL,                -- mikrodetik (Date.now()*1000), penanda urutan pesan
  telegram_message_id BIGINT
);
CREATE INDEX IF NOT EXISTS idx_chat_memory_chat_ts ON chat_memory (chat_id, ts DESC);

-- 1 baris per chat: penanda topik, ringkasan, status pause
CREATE TABLE IF NOT EXISTS chat_state (
  id TEXT PRIMARY KEY,               -- chat id (string)
  topic_ts BIGINT NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  summarized_up_to_ts BIGINT NOT NULL DEFAULT 0,
  is_paused BOOLEAN NOT NULL DEFAULT FALSE
);

-- Pengaturan bot dinamis (model / base_url / api_key / fallback_models). Selalu tepat 1 baris (id = 1).
CREATE TABLE IF NOT EXISTS bot_config (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  model TEXT,
  base_url TEXT,
  api_key TEXT,
  fallback_models TEXT,
  updated_at BIGINT                  -- Date.now() milidetik
);
ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS fallback_models TEXT;

-- Sistem akses pengguna (approval / whitelist)
CREATE TABLE IF NOT EXISTS user_access (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,              -- pending / approved / blocked
  name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  updated_at BIGINT
);
