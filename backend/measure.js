import puppeteer from "puppeteer";

export async function measurePage(url) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  const resources = [];
  page.on("request", (request) => {
    resources.push({
      url: request.url(),
      type: request.resourceType(),
      startTime: Date.now(),
      endTime: null,
      sizeKB: 0,
      duration: 0,
    });
  });

  page.on("requestfinished", async (request) => {
    const resObj = resources.find(
      (r) => r.url === request.url() && r.endTime === null
    );
    if (!resObj) return;
    const response = request.response();
    const size = parseInt(response.headers()["content-length"]) || 0;
    resObj.endTime = Date.now();
    resObj.sizeKB = +(size / 1024).toFixed(2);
    resObj.duration = resObj.endTime - resObj.startTime;
  });

  const start = Date.now();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForSelector("main", { timeout: 10000 });
  } catch (err) {
    console.warn("⚠️ Navegación incompleta:", err.message);
  }

  const fcp = await page.evaluate(async () => {
    for (let i = 0; i < 20; i++) {
      const paints = performance.getEntriesByType("paint");
      const fcpEntry = paints.find((p) => p.name === "first-contentful-paint");
      if (fcpEntry) return fcpEntry.startTime;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  });

  const perf = await page.evaluate(() => {
    const [nav] = performance.getEntriesByType("navigation");
    if (!nav) return {};
    return {
      dnsLookup: nav.domainLookupEnd - nav.domainLookupStart,
      tcpConnect: nav.connectEnd - nav.connectStart,
      ttfb: nav.responseStart - nav.requestStart,
      response: nav.responseEnd - nav.responseStart,
      domContentLoaded: nav.domContentLoadedEventEnd,
      totalLoad: nav.loadEventEnd || performance.now(),
    };
  });

  const realLoadTime = perf.totalLoad?.toFixed(2) || null;
  const loadTime = Date.now() - start;

  const resourceTimings = await page.evaluate(() => {
    return performance.getEntriesByType("resource").map((r) => ({
      name: r.name,
      type: r.initiatorType,
      startTime: r.startTime.toFixed(2),
      duration: r.duration.toFixed(2),
      transferSizeKB: (r.transferSize / 1024).toFixed(2),
      encodedBodySizeKB: (r.encodedBodySize / 1024).toFixed(2),
    }));
  });

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
        setTimeout(() => resolve(results), 15000);
      });
    });
  } catch {}

  await browser.close();

  const totalSize = resources.reduce((acc, r) => acc + (r.sizeKB || 0), 0);
  const grouped = resources.reduce((acc, r) => {
    acc[r.type] = (acc[r.type] || 0) + 1;
    return acc;
  }, {});

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
  };
}
