import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pool, { initDB } from "./db.js";
import { measurePage } from "./measure.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

dotenv.config();
await initDB();

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "claveSuperSegura";

// -----------------------------------------------------------
//  MIDDLEWARE: Autenticación
// -----------------------------------------------------------
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Falta token" });

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido o expirado" });
  }
}

// -----------------------------------------------------------
//  REGISTER (PÚBLICO)
// -----------------------------------------------------------
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;

  const hash = await bcrypt.hash(password, 10);

  try {
    const result = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username",
      [username, hash]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "Usuario ya existe o error al registrar" });
  }
});

// -----------------------------------------------------------
//  LOGIN (PÚBLICO)
// -----------------------------------------------------------
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  const userResult = await pool.query(
    "SELECT * FROM users WHERE username = $1",
    [username]
  );

  const user = userResult.rows[0];
  if (!user) return res.status(401).json({ error: "Usuario no encontrado" });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Contraseña incorrecta" });

  const token = jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: "2h" }
  );

  res.json({ token });
});

// -----------------------------------------------------------
//  AÑADIR URL (PROTEGIDO)
// -----------------------------------------------------------
app.post("/api/urls", authMiddleware, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Falta el campo 'url'" });

  try {
    await pool.query(
      "INSERT INTO urls (url, user_id) VALUES ($1, $2) ON CONFLICT (user_id, url) DO NOTHING",
      [url, req.user.id]
    );

    res.json({ message: `✅ URL añadida: ${url}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: true, message: err.message });
  }
});

// -----------------------------------------------------------
//  MEDIR URL Y GUARDAR MÉTRICAS (PROTEGIDO)
// -----------------------------------------------------------
app.post("/api/metrics", authMiddleware, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Falta el campo 'url'" });

  try {
    const data = await measurePage(url);

    let urlResult = await pool.query(
      "SELECT id FROM urls WHERE url=$1 AND user_id=$2",
      [url, req.user.id]
    );

    let urlId;
    if (urlResult.rows.length === 0) {
      const insertUrl = await pool.query(
        "INSERT INTO urls (url, user_id) VALUES ($1, $2) RETURNING id",
        [url, req.user.id]
      );
      urlId = insertUrl.rows[0].id;
    } else {
      urlId = urlResult.rows[0].id;
    }

    await pool.query(
      `INSERT INTO metrics 
      (url_id, user_id, fcp, real_load_time, load_time, total_size_kb, resource_count, performance, web_vitals)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        urlId,
        req.user.id,
        data.fcp,
        data.realLoadTime,
        data.loadTime,
        data.totalSizeKB,
        data.resourceCount,
        data.performance,
        data.webVitals,
      ]
    );

    res.json({ message: "✅ Métricas guardadas correctamente", data });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: true, message: err.message });
  }
});

// -----------------------------------------------------------
//  OBTENER MIS MÉTRICAS (PROTEGIDO)
// -----------------------------------------------------------
app.get("/api/my-metrics", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, u.url 
       FROM metrics m
       JOIN urls u ON m.url_id = u.id
       WHERE m.user_id = $1
       ORDER BY m.created_at DESC`,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener métricas" });
  }
});

// -----------------------------------------------------------
//  OBTENER MIS URLs (PROTEGIDO)
// -----------------------------------------------------------
app.get("/api/urls", authMiddleware, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM urls WHERE user_id=$1 ORDER BY created_at DESC",
    [req.user.id]
  );

  res.json(result.rows);
});

// -----------------------------------------------------------
//  MÉTRICAS DE UNA URL CONCRETA (PROTEGIDO)
// -----------------------------------------------------------
app.get("/api/metrics/:urlId", authMiddleware, async (req, res) => {
  const { urlId } = req.params;

  const result = await pool.query(
    `SELECT * FROM metrics WHERE url_id = $1 AND user_id=$2 ORDER BY created_at DESC`,
    [urlId, req.user.id]
  );

  res.json(result.rows);
});

// -----------------------------------------------------------
//  MEDICIÓN AUTOMÁTICA CADA 6 HORAS (POR USUARIO)
// -----------------------------------------------------------
async function medirTodasLasUrls() {
  console.log("🔁 Iniciando medición periódica...");

  const result = await pool.query("SELECT * FROM urls");

  for (const row of result.rows) {
    try {
      const data = await measurePage(row.url);

      await pool.query(
        `INSERT INTO metrics
        (url_id, user_id, fcp, real_load_time, load_time, total_size_kb, resource_count, performance, web_vitals)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          row.id,
          row.user_id,
          data.fcp,
          data.realLoadTime,
          data.loadTime,
          data.totalSizeKB,
          data.resourceCount,
          data.performance,
          data.webVitals,
        ]
      );

      console.log(`✅ Métricas guardadas para ${row.url}`);
    } catch (err) {
      console.error(`❌ Error midiendo ${row.url}:`, err.message);
    }
  }
}

setInterval(medirTodasLasUrls, 6 * 60 * 60 * 1000);

// -----------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
