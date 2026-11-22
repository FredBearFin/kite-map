// Screenshots of the app (web build) with real map, terrain, satellite and
// wind data, for handing over builds. Run in CI (needs internet):
//   npx vite preview --port 4173 &  node tools/screenshots.cjs out-dir
const { chromium } = require('playwright');
const fs = require('fs');

const out = process.argv[2] || 'screenshots';
const PLACE = { name: 'lake-mcconaughy', center: [-101.74, 41.235], zoom: 11.3 };

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text().slice(0, 200)));
  page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 300)));
  await page.goto('http://localhost:4173');
  await page.waitForFunction(() => window.__kite?.map?.isStyleLoaded(), null, { timeout: 60000 });
  await page.evaluate((p) => {
    document.querySelector('#tabs button[data-tab="spots"]')?.click();
    window.__kite.map.jumpTo({ center: p.center, zoom: p.zoom });
  }, PLACE);
  // Wait for the shore scan and wind download to finish.
  const t0 = Date.now();
  await page.waitForFunction(() => window.__kite.state.spots.length > 0 && document.getElementById('banner').hidden, null, { timeout: 240000, polling: 2000 }).catch(() => console.log('scan did not finish in time'));
  await page.waitForTimeout(8000);
  console.log(`scan ${((Date.now() - t0) / 1000).toFixed(0)} s, spots`, await page.evaluate(() => window.__kite.state.spots.slice(0, 5).map((s) => s.score)));
  await page.screenshot({ path: `${out}/1-map-spots.png` });

  await page.evaluate(() => window.__kite.spotPopup(0));
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}/2-spot-popup.png` });

  await page.evaluate(() => window.__kite.spotView(0));
  await page.waitForTimeout(45000);
  await page.screenshot({ path: `${out}/3-spot-3d.png` });

  // Look around: turn right and show another wind direction.
  await page.evaluate(() => document.querySelectorAll('#sv-panel .sv-dirs button')[1]?.click());
  await page.waitForTimeout(30000);
  await page.screenshot({ path: `${out}/4-spot-3d-other-wind.png` });
  await browser.close();
})();
