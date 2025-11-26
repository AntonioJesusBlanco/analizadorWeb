import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import pool, { initDB } from "./db.js"
import { measurePage } from "./measure.js"
import bcrypt from "bcrypt"
import jwt from "jsonwebtoken"

dotenv.config()
await initDB()

const app = express()
app.use(cors())
app.use(express.json())

const JWT_SECRET = process.env.JWT_SECRET || "claveSuperSegura"

// -----------------------------------------------------------
//  MIDDLEWARE: Autenticación
// -----------------------------------------------------------
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader) return res.status(401).json({ error: "Falta token" })

  const token = authHeader.split(" ")[1]

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    req.user = decoded
    next()
  } catch {
    return res.status(401).json({ error: "Token inválido o expirado" })
  }
}

// -----------------------------------------------------------
//  REGISTER (PÚBLICO)
// -----------------------------------------------------------
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body

  const hash = await bcrypt.hash(password, 10)

  try {
    const result = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username",
      [username, hash],
    )

    res.json(result.rows[0])
  } catch (err) {
    console.error(err)
    res.status(400).json({ error: "Usuario ya existe o error al registrar" })
  }
})

// -----------------------------------------------------------
//  LOGIN (PÚBLICO)
// -----------------------------------------------------------
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body

  const userResult = await pool.query("SELECT * FROM users WHERE username = $1", [username])

  const user = userResult.rows[0]
  if (!user) return res.status(401).json({ error: "Usuario no encontrado" })

  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) return res.status(401).json({ error: "Contraseña incorrecta" })

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "2h" })

  res.json({ token })
})

// -----------------------------------------------------------
//  LOGOUT (PÚBLICO)
// -----------------------------------------------------------
app.post("/api/logout", (req, res) => {
  // El token se almacena en localStorage del cliente, aquí es más una confirmación
  res.json({ message: "Sesión cerrada correctamente" })
})

// -----------------------------------------------------------
//  AÑADIR URL (PROTEGIDO)
// -----------------------------------------------------------
app.post("/api/urls", authMiddleware, async (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: "Falta el campo 'url'" })

  try {
    await pool.query("INSERT INTO urls (url, user_id) VALUES ($1, $2) ON CONFLICT (user_id, url) DO NOTHING", [
      url,
      req.user.id,
    ])

    res.json({ message: `✅ URL añadida: ${url}` })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: true, message: err.message })
  }
})

// -----------------------------------------------------------
//  MEDIR URL Y GUARDAR MÉTRICAS + FILES (PROTEGIDO)
// -----------------------------------------------------------
app.post("/api/metrics", authMiddleware, async (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: "Falta el campo 'url'" })

  try {
    console.log("[v0] ========================================")
    console.log("[v0] Iniciando medición de:", url)
    console.log("[v0] Usuario ID:", req.user.id)
    const data = await measurePage(url)
    console.log("[v0] Medición completada")
    console.log("[v0] pageResources:", data.pageResources)
    console.log("[v0] Archivos encontrados:", data.pageResources?.length || 0)

    const urlResult = await pool.query("SELECT id FROM urls WHERE url=$1 AND user_id=$2", [url, req.user.id])

    let urlId
    if (urlResult.rows.length === 0) {
      const insertUrl = await pool.query("INSERT INTO urls (url, user_id) VALUES ($1, $2) RETURNING id", [
        url,
        req.user.id,
      ])
      urlId = insertUrl.rows[0].id
      console.log("[v0] URL creada con ID:", urlId)
    } else {
      urlId = urlResult.rows[0].id
      console.log("[v0] URL existente con ID:", urlId)
    }

    const metricsResult = await pool.query(
      `INSERT INTO metrics 
      (url_id, user_id, fcp, real_load_time, load_time, total_size_kb, resource_count, performance, web_vitals)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        urlId,
        req.user.id,
        data.fcp,
        data.realLoadTime,
        data.loadTime,
        data.totalSizeKB,
        data.resourceCount,
        JSON.stringify(data.performance),
        JSON.stringify(data.webVitals),
      ],
    )
    console.log("[v0] Métricas insertadas con ID:", metricsResult.rows[0].id)

    if (data.pageResources && data.pageResources.length > 0) {
      console.log("[v0] ========== GUARDANDO ARCHIVOS ==========")
      console.log("[v0] Total archivos a guardar:", data.pageResources.length)
      for (const resource of data.pageResources) {
        try {
          console.log(`[v0] → Guardando: ${resource.name} | Tipo: ${resource.type} | Size: ${resource.size} KB`)
          const fileResult = await pool.query(
            `INSERT INTO files 
            (url_id, file_name, file_type, file_content, content_size_kb, real_load_time)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [urlId, resource.name, resource.type, resource.content, resource.size, resource.realLoadTime],
          )
          console.log(`[v0] ✓ Archivo guardado con ID: ${fileResult.rows[0].id}`)
        } catch (err) {
          console.error(`[v0] ✗ Error guardando ${resource.name}:`, err.message)
        }
      }
      console.log("[v0] ==========================================")
    } else {
      console.log("[v0] ⚠️ No hay archivos para guardar")
    }

    // Guardar HTML
    if (data.pageContent && data.pageContent.html) {
      try {
        console.log("[v0] Guardando HTML principal...")
        await pool.query(
          `INSERT INTO files 
          (url_id, file_name, file_type, file_content, content_size_kb, real_load_time)
          VALUES ($1, $2, $3, $4, $5, $6)`,
          [urlId, "index.html", "document", data.pageContent.html, data.pageContent.size, data.realLoadTime],
        )
        console.log("[v0] ✓ HTML guardado correctamente")
      } catch (err) {
        console.error("[v0] ✗ Error guardando HTML:", err.message)
      }
    }

    res.json({
      message: "✅ Métricas y archivos guardados correctamente",
      filesCount: (data.pageResources?.length || 0) + 1,
      data,
    })
    console.log("[v0] ========================================")
  } catch (err) {
    console.error("❌ Error en /api/metrics:", err)
    res.status(500).json({ error: true, message: err.message })
  }
})

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
      [req.user.id],
    )

    res.json(result.rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: "Error al obtener métricas" })
  }
})

// -----------------------------------------------------------
//  OBTENER MIS URLs (PROTEGIDO)
// -----------------------------------------------------------
app.get("/api/urls", authMiddleware, async (req, res) => {
  const result = await pool.query("SELECT * FROM urls WHERE user_id=$1 ORDER BY created_at DESC", [req.user.id])

  res.json(result.rows)
})

// -----------------------------------------------------------
//  OBTENER DISTRIBUCIÓN DE TIPOS DE ARCHIVOS (PROTEGIDO)
// -----------------------------------------------------------
app.get("/api/files/stats/:urlId", authMiddleware, async (req, res) => {
  const { urlId } = req.params

  try {
    // Verificar que el usuario es dueño de esta URL
    const urlCheck = await pool.query("SELECT id FROM urls WHERE id=$1 AND user_id=$2", [urlId, req.user.id])

    if (urlCheck.rows.length === 0) {
      return res.status(403).json({ error: "No tienes acceso a esta URL" })
    }

    // Agrupar archivos por tipo y contar
    const result = await pool.query(
      `SELECT 
        file_type, 
        COUNT(*) as count,
        SUM(content_size_kb) as total_size,
        AVG(real_load_time) as avg_load_time
       FROM files 
       WHERE url_id = $1 
       GROUP BY file_type
       ORDER BY count DESC`,
      [urlId],
    )

    res.json(result.rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: "Error al obtener estadísticas de archivos" })
  }
})

// -----------------------------------------------------------
//  OBTENER ARCHIVOS DE UNA URL (PROTEGIDO)
// -----------------------------------------------------------
app.get("/api/files/:urlId", authMiddleware, async (req, res) => {
  const { urlId } = req.params

  try {
    // Verificar que el usuario es dueño de esta URL
    const urlCheck = await pool.query("SELECT id FROM urls WHERE id=$1 AND user_id=$2", [urlId, req.user.id])

    if (urlCheck.rows.length === 0) {
      return res.status(403).json({ error: "No tienes acceso a esta URL" })
    }

    const result = await pool.query(
      `SELECT id, file_name, file_type, content_size_kb, created_at 
       FROM files 
       WHERE url_id = $1 
       ORDER BY created_at DESC`,
      [urlId],
    )

    res.json(result.rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: "Error al obtener archivos" })
  }
})

// -----------------------------------------------------------
//  MÉTRICAS DE UNA URL CONCRETA (PROTEGIDO)
// -----------------------------------------------------------
app.get("/api/metrics/:urlId", authMiddleware, async (req, res) => {
  const { urlId } = req.params

  const result = await pool.query(`SELECT * FROM metrics WHERE url_id = $1 AND user_id=$2 ORDER BY created_at DESC`, [
    urlId,
    req.user.id,
  ])

  res.json(result.rows)
})

// -----------------------------------------------------------
//  OBTENER CONTENIDO DE UN ARCHIVO ESPECÍFICO (PROTEGIDO)
// -----------------------------------------------------------
app.get("/api/files/content/:fileId", authMiddleware, async (req, res) => {
  const { fileId } = req.params

  try {
    const result = await pool.query(
      `SELECT f.id, f.file_name, f.file_type, f.file_content, u.user_id
       FROM files f
       JOIN urls u ON f.url_id = u.id
       WHERE f.id = $1`,
      [fileId],
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Archivo no encontrado" })
    }

    const file = result.rows[0]

    // Verificar permisos
    if (file.user_id !== req.user.id) {
      return res.status(403).json({ error: "No tienes acceso a este archivo" })
    }

    res.json({
      name: file.file_name,
      type: file.file_type,
      content: file.file_content,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: "Error al obtener el contenido del archivo" })
  }
})

// -----------------------------------------------------------
//  MEDICIÓN AUTOMÁTICA CADA 6 HORAS (POR USUARIO)
// -----------------------------------------------------------
async function medirTodasLasUrls() {
  console.log("🔁 Iniciando medición periódica...")

  const result = await pool.query("SELECT * FROM urls")

  for (const row of result.rows) {
    try {
      const data = await measurePage(row.url)

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
          JSON.stringify(data.performance),
          JSON.stringify(data.webVitals),
        ],
      )

      if (data.pageResources && data.pageResources.length > 0) {
        for (const resource of data.pageResources) {
          await pool.query(
            `INSERT INTO files 
            (url_id, file_name, file_type, file_content, content_size_kb, real_load_time)
            VALUES ($1, $2, $3, $4, $5, $6)`,
            [row.id, resource.name, resource.type, resource.content, resource.size, resource.realLoadTime],
          )
        }
      }

      if (data.pageContent && data.pageContent.html) {
        await pool.query(
          `INSERT INTO files 
          (url_id, file_name, file_type, file_content, content_size_kb, real_load_time)
          VALUES ($1, $2, $3, $4, $5, $6)`,
          [row.id, "index.html", "document", data.pageContent.html, data.pageContent.size, data.realLoadTime],
        )
      }

      console.log(`✅ Métricas y archivos guardados para ${row.url}`)
    } catch (err) {
      console.error(`❌ Error midiendo ${row.url}:`, err.message)
    }
  }
}

setInterval(medirTodasLasUrls, 6 * 60 * 60 * 1000)

// -----------------------------------------------------------
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`))
