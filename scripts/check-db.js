// Probe koneksi DATABASE_URL dari .env. Exit 0 jika bisa connect & query, 1 jika gagal.
// Dipakai oleh scripts/setup-vps.sh (mode --check dan setelah menjalankan container).
require("dotenv").config();

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL belum diisi di .env");
    process.exit(1);
  }
  const { Client } = require("pg");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
  } catch (err) {
    console.error("PostgreSQL tidak merespons:", err.message);
    process.exit(1);
  }
})();
