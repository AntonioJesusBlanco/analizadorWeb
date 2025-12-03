import pkg from "pg";
const { Pool } = pkg;

import dotenv from "dotenv";
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS urls (
      id SERIAL PRIMARY KEY,
      url TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (url, user_id)
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id SERIAL PRIMARY KEY,
      url_id INTEGER REFERENCES urls(id) ON DELETE CASCADE,
      fcp REAL,
      real_load_time REAL,
      load_time REAL,
      total_size_kb REAL,
      resource_count INTEGER,
      performance JSON,
      web_vitals JSON,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}


export default pool;
