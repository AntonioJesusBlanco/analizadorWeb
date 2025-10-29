import express from "express";
import puppeteer from "puppeteer";
import cors from "cors";

const app = express();
app.use(cors());
const PORT = 3000;

const pageUrl = "https://antoniojesus.vercel.app/";
let metrics = {};

async function measurePage(url) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  // Recoger recursos
  const resources = [];
 page.on("requestfinished", async (request) => {
  try {
    const response = request.response();
    if (!response) return;

    const timing = response.timing();
    const headers = response.headers();
    const size = headers["content-length"] ? parseInt(headers["content-length"]) : 0;

    resources.push({
      url: request.url(),
      type: request.resourceType(),
      duration: timing.receiveHeadersEnd - timing.sendEnd,
      sizeKB: +(size / 1024).toFixed(2)
    });
  } catch (err) {
    console.error("Error midiendo recurso:", err);
  }
});


  const start = Date.now();
  try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  // Espera un selector estable de la SPA
  await page.waitForSelector("main", { timeout: 15000 });
} catch (err) {
  console.warn("SPA navigation falló, continuando con lo que se cargó:", err.message);
}

  const loadTime = Date.now() - start;

  // Performance Timing API
  const perf = await page.evaluate(() => {
    const t = window.performance.timing;
    return {
      dnsLookup: t.domainLookupEnd - t.domainLookupStart,
      tcpConnect: t.connectEnd - t.connectStart,
      ttfb: t.responseStart - t.requestStart,
      response: t.responseEnd - t.responseStart,
      domContentLoaded: t.domContentLoadedEventEnd - t.navigationStart,
      totalLoad: t.loadEventEnd - t.navigationStart,
    };
  });

  // Web Vitals
  let webVitals = {};
  try {
    webVitals = await page.evaluate(async () => {
      if (!window.webVitals) {
        await new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = "https://unpkg.com/web-vitals@3/dist/web-vitals.iife.js";
          s.onload = res;
          s.onerror = rej;
          document.head.appendChild(s);
        });
      }

      return new Promise((resolve) => {
        const results = {};
        const { getCLS, getFID, getLCP, getFCP, getTTFB } = window.webVitals;
        let completed = 0;
        const done = () => {
          completed++;
          if (completed === 5) resolve(results);
        };
        getCLS((m) => ((results.CLS = m.value), done()));
        getFID((m) => ((results.FID = m.value), done()));
        getLCP((m) => ((results.LCP = m.value), done()));
        getFCP((m) => ((results.FCP = m.value), done()));
        getTTFB((m) => ((results.TTFB = m.value), done()));
        setTimeout(() => resolve(results), 15000); // fallback 15s
      });
    });
  } catch {}

  await browser.close();

  const totalSize = resources.reduce((acc, r) => acc + (r.size || 0), 0);
  const grouped = resources.reduce((acc, r) => {
    acc[r.type] = (acc[r.type] || 0) + 1;
    return acc;
  }, {});

  return {
  url,
  timestamp: new Date().toISOString(),
  loadTime,
  totalSizeKB: (resources.reduce((acc, r) => acc + (r.sizeKB || 0), 0)).toFixed(2),
  resourceCount: resources.length,
  resourceTypes: grouped,
  resources, // <-- Aquí incluimos el detalle de cada recurso
  performance: perf,
  webVitals,
};

}

async function updateMetrics() {
  try {
    const result = await measurePage(pageUrl);
    metrics = result;
    console.log(`[${pageUrl}] ✅ Medición completada - Load: ${result.loadTime}ms`);
  } catch (err) {
    console.error(`[${pageUrl}] ❌ ERROR`, err);
    metrics = {
      error: true,
      message: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString(),
    };
  }
}

setInterval(updateMetrics, 5 * 60 * 1000);
updateMetrics();

app.get("/api/metrics", (req, res) => res.json(metrics));

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
