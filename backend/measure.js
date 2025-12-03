// Dentro de measure.js
import puppeteer from "puppeteer";
import fs from "fs/promises"; // Módulo nativo para leer archivos
import path from "path";       // Módulo nativo para construir rutas

// Ubicación estándar de caché en Render que sabemos que existe
const PUPPETEER_CACHE_DIR = "/opt/render/.cache/puppeteer";

async function getExecutablePath() {
    // Si la variable de entorno funciona por casualidad, la usamos (aunque es improbable)
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    
    try {
        const chromeCacheDir = path.join(PUPPETEER_CACHE_DIR, 'chrome');
        
        // 1. Leer el contenido de la caché para encontrar la carpeta de versión
        const contents = await fs.readdir(chromeCacheDir);
        
        // 2. Buscar la carpeta que empieza por 'linux-' (ej: linux-143.0.7499.40)
        const versionDir = contents.find(name => name.startsWith('linux-'));

        if (versionDir) {
            // 3. Construir la ruta absoluta y correcta
            return path.join(chromeCacheDir, versionDir, 'chrome-linux64', 'chrome');
        }
    } catch (e) {
        console.error("Error al buscar el binario de Chrome de forma dinámica:", e.message);
    }
    
    // Fallback: Si todo falla, devuelve la ruta que lanza el error original.
    return "/usr/bin/chromium-browser"; 
}


export async function measurePage(url) {
 
    const finalExecutablePath = await getExecutablePath();
    
    // Si la búsqueda falla, la aplicación lanzará el error de "Browser not found"
    if (finalExecutablePath.includes("chromium-browser")) {
        throw new Error(`Could not find Chrome. The configured executablePath (${finalExecutablePath}) failed.`);
    }

    console.log(`Lanzando Chrome desde la ruta dinámica: ${finalExecutablePath}`);

    const browser = await puppeteer.launch({
      headless: true,
      executablePath: finalExecutablePath, // ¡Esta es la ruta dinámica y correcta!
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    })
    


  const page = await browser.newPage()
  await page.setViewport({ width: 1366, height: 768 })

  const resources = []
  const resourceMap = new Map()

  page.on("response", async (response) => {
    try {
      const responseUrl = response.url()
      const contentType = response.headers()["content-type"] || ""

      // Capturar todos los archivos excepto documentos HTML principales y sourcemaps
      const isHtml = contentType.includes("text/html")
      const isSourceMap = responseUrl.includes(".map")

      if (!isHtml && !isSourceMap) {
        try {
          const buffer = await response.buffer()
          const fileName = responseUrl.split("/").pop() || "desconocido"
          const fileType = getFileType(contentType, fileName)

          // Solo guardar contenido de texto/código, no binarios
          let fileContent = ""
          if (shouldCapureContent(contentType)) {
            fileContent = buffer.toString("utf-8", 0, Math.min(100000, buffer.length))
          }

          resourceMap.set(responseUrl, {
            name: fileName,
            type: fileType,
            content: fileContent,
            size: (buffer.length / 1024).toFixed(2),
            contentType: contentType,
            url: responseUrl,
          })
          console.log(` Archivo capturado: ${fileName}, tipo: ${fileType}, ${resourceMap.get(responseUrl).size} KB`,)
        } catch (bufferErr) {
          console.warn(` No se pudo leer buffer de ${responseUrl}:`, bufferErr.message)
        }
      }
    } catch (err) {
      console.warn(` Error procesando respuesta:`, err.message)
    }
  })

  page.on("request", (request) => {
    resources.push({
      url: request.url(),
      type: request.resourceType(),
      startTime: Date.now(),
      endTime: null,
      sizeKB: 0,
      duration: 0,
    })
  })

  page.on("requestfinished", async (request) => {
    const resObj = resources.find((r) => r.url === request.url() && r.endTime === null)
    if (!resObj) return
    const response = request.response()
    if (!response) return
    const size = Number.parseInt(response.headers()["content-length"]) || 0
    resObj.endTime = Date.now()
    resObj.sizeKB = +(size / 1024).toFixed(2)
    resObj.duration = resObj.endTime - resObj.startTime
  })

  const start = Date.now()

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 })
    await page.waitForSelector("main", { timeout: 10000 }).catch(() => {})
  } catch (err) {
    console.warn(" Error:", err.message)
  }

  await new Promise((resolve) => setTimeout(resolve, 2000))

  const fcp = await page.evaluate(async () => {
    for (let i = 0; i < 20; i++) {
      const paints = performance.getEntriesByType("paint")
      const fcpEntry = paints.find((p) => p.name === "first-contentful-paint")
      if (fcpEntry) return fcpEntry.startTime
      await new Promise((r) => setTimeout(r, 100))
    }
    return null
  })

    const perf = await page.evaluate(() => {
    const [nav] = performance.getEntriesByType("navigation")
    if (!nav) return {}
    return {
      dnsLookup: nav.domainLookupEnd - nav.domainLookupStart,
      tcpConnect: nav.connectEnd - nav.connectStart,
      ttfb: nav.responseStart - nav.requestStart,
      response: nav.responseEnd - nav.responseStart,
      domContentLoaded: nav.domContentLoadedEventEnd,
      totalLoad: nav.loadEventEnd || performance.now(),
    }
  })

  const realLoadTime = perf.totalLoad?.toFixed(2) || null
  const loadTime = Date.now() - start

  const resourceTimings = await page.evaluate(() => {
    return performance.getEntriesByType("resource").map((resource) => ({
      name: resource.name,
      type: resource.initiatorType,
      startTime: resource.startTime.toFixed(2),
      duration: resource.duration.toFixed(2),
      transferSizeKB: (resource.transferSize / 1024).toFixed(2),
      encodedBodySizeKB: (resource.encodedBodySize / 1024).toFixed(2),
    }))
  })
  let webVitals = {}
  try {
    webVitals = await page.evaluate(async () => {
      if (!window.webVitals) {
        await new Promise((res, rej) => {
          const scriptWebVitals = document.createElement("script")
          scriptWebVitals.src = "https://unpkg.com/web-vitals@3/dist/web-vitals.iife.js"
          scriptWebVitals.onload = res
          scriptWebVitals.onerror = rej
          document.head.appendChild(scriptWebVitals)
        })
      }
      return new Promise((resolve) => {
        const results = {}
        
        const { getCLS, getLCP, getFCP, getTTFB } = window.webVitals
        let completed = 0
        const done = () => {
          completed++
          if (completed === 5) resolve(results)
        }
        getCLS((m) => ((results.CLS = m.value), done()))
        getLCP((m) => ((results.LCP = m.value), done()))
        getFCP((m) => ((results.FCP = m.value), done()))
        getTTFB((m) => ((results.TTFB = m.value), done()))
        setTimeout(() => resolve(results), 15000)
      })
    })
  } catch {}

  const pageResources = Array.from(resourceMap.values()).map((resource) => ({
    ...resource,
    realLoadTime: Number.parseFloat(realLoadTime),
  }))

  console.log(` Total archivos capturados: ${pageResources.length}`)

  const pageContent = {
    html: await page.content(),
    size: (await page.content()).length / 1024,
  }

  await browser.close()

  const totalSize = resources.reduce((acc, resource) => acc + (resource.sizeKB || 0), 0)
  const grouped = resources.reduce((acc, resource) => {
    acc[resource.type] = (acc[resource.type] || 0) + 1
    return acc
  }, {})

  return {
    url,
    timestamp: new Date().toISOString(),
    fcp,
    realLoadTime,
    loadTime,
    totalSizeKB: totalSize.toFixed(2),
    resourceCount: resources.length,
    resourceTypes: grouped,
    resources: resourceTimings,
    performance: perf,
    webVitals,
    pageResources,
    pageContent,
  }
}

function getFileType(contentType, fileName) {
  if (contentType.includes("javascript")) return "javascript"
  if (contentType.includes("css")) return "stylesheet"
  if (contentType.includes("image")) return "image"
  if (contentType.includes("font")) return "font"
  if (contentType.includes("json")) return "json"
  if (contentType.includes("video")) return "video"
  if (contentType.includes("audio")) return "audio"
  if (contentType.includes("xml") || contentType.includes("rss")) return "xml"
  if (contentType.includes("pdf")) return "pdf"
  if (contentType.includes("text")) return "text"
  if (contentType.includes("application")) return "application"

  // Detectar por extensión si no hay Content-Type claro
  const ext = fileName.split(".").pop().toLowerCase()
  const typeMap = {
    js: "javascript",
    css: "stylesheet",
    png: "image", jpg: "image", jpeg: "image", gif: "image", svg: "image", webp: "image",
    ttf: "font", woff: "font", woff2: "font", eot: "font",
    json: "json",
    mp4: "video", webm: "video",
    mp3: "audio", wav: "audio",
    pdf: "pdf",
    xml: "xml",
  }

  return typeMap[ext] || "other"
}

function shouldCapureContent(contentType) {
  // Guardar contenido de texto/código
  const textTypes = ["javascript", "css", "json", "xml", "text", "application/json", "application/javascript", "text/html",
  ]
  return textTypes.some((type) => contentType.includes(type))
}
