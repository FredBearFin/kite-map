// Screenshots of the app (web build) with real map, terrain, satellite and
// wind data, for handing over builds. Run in CI (needs internet):
//   npx vite preview --port 4173 &  node tools/screenshots.cjs out-dir
const { chromium } = require('playwright');
const fs = require('fs');

const out = process.argv[2] || 'screenshots';
const PLACE = { name: 'lake-mcconaughy', center: [-101.74, 41.235], zoom: 11.3 };

// Wait until the camera has stopped and every tile (terrain too) has drawn.
async function waitIdle(page, ms = 240000) {
  await page.waitForTimeout(3000);
  const t0 = Date.now();
  const ok = await page.evaluate((ms) => new Promise((resolve) => {
    const m = window.__kite.map;
    const done = () => resolve(true);
    const check = () => (!m.isMoving() && m.loaded() && m.areTilesLoaded() ? done() : m.once('idle', check));
    setTimeout(() => resolve(false), ms);
    m.triggerRepaint();
    check();
  }), ms);
  await page.waitForTimeout(4000);
  console.log(`idle ${ok} after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

// The CI machine draws 3D in software, so a normal page screenshot can wait
// minutes for a frame. Copy the map's last frame into an image over the map,
// hide the WebGL canvas, then take the page screenshot.
async function snap3d(page, path) {
  await page.evaluate(() => document.getElementById('snap')?.remove());
  await page.evaluate(() => { window.__kite.map.getCanvas().style.visibility = 'visible'; });
  const url = await page.evaluate(() => new Promise((res) => {
    const m = window.__kite.map;
    m.once('render', () => res(m.getCanvas().toDataURL('image/png')));
    m.triggerRepaint();
  }));
  await page.evaluate((u) => {
    const img = document.createElement('img');
    img.id = 'snap';
    img.src = u;
    Object.assign(img.style, { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', zIndex: 4, pointerEvents: 'none' });
    document.getElementById('map').appendChild(img);
    window.__kite.map.getCanvas().style.visibility = 'hidden';
  }, url);
  await page.waitForTimeout(1500);
  await page.screenshot({ path, timeout: 300000 });
  await page.evaluate(() => { document.getElementById('snap')?.remove(); window.__kite.map.getCanvas().style.visibility = 'visible'; });
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  // 1x: the CI machine draws 3D terrain in software, and 2x takes minutes per frame.
  const DPR = +(process.env.DPR || 1);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: DPR });
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.log('console:', m.text().slice(0, 200)));
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
  await page.evaluate(() => window.__kite.sv.pause());
  await waitIdle(page);

  // One picture per guide step, at a moment where the rider is mid-action.
  const STEP_T = { wind: 4, launch: 7, ride: 5, upwind: 9, land: 6, bail: 7 };
  const keys = await page.evaluate(() => window.__kite.sv.steps);
  for (let i = 0; i < keys.length; i++) {
    await page.evaluate(({ i, t }) => { window.__kite.sv.step(i); window.__kite.sv.pause(); window.__kite.sv.setTime(t); }, { i, t: STEP_T[keys[i]] });
    await waitIdle(page);
    await snap3d(page, `${out}/${3 + i}-step-${i + 1}-${keys[i]}.png`);
  }

  // Another wind direction and a strong wind, on the riding step.
  await page.evaluate(() => { const c = window.__kite.sv; c.step(2); c.pause(); c.speed(28); });
  await page.evaluate(() => { const b = document.querySelectorAll('#sv-panel .sv-dirs button')[1]; if (b) b.click(); window.__kite.sv.pause(); window.__kite.sv.setTime(5); });
  await waitIdle(page);
  await snap3d(page, `${out}/9-other-wind-strong.png`);

  // Animation frames for GIFs: the map canvas only, drawn at exact moments.
  async function frames(name, step, t0, t1, n) {
    fs.mkdirSync(`${out}/frames-${name}`, { recursive: true });
    await page.evaluate((i) => { const c = window.__kite.sv; c.speed(18); c.step(i); c.pause(); }, step);
    await waitIdle(page);
    for (let k = 0; k < n; k++) {
      const url = await page.evaluate((t) => new Promise((res) => {
        const m = window.__kite.map;
        window.__kite.sv.setTime(t);
        let done = false;
        const grab = () => { if (done) return; done = true; m.once('render', () => res(m.getCanvas().toDataURL('image/png'))); m.triggerRepaint(); };
        m.once('idle', grab);
        setTimeout(grab, 8000);
      }), t0 + ((t1 - t0) * k) / n);
      fs.writeFileSync(`${out}/frames-${name}/${String(k).padStart(3, '0')}.png`, Buffer.from(url.split(',')[1], 'base64'));
    }
    console.log('frames', name, n);
  }
  await frames('ride', 2, 0, 9, 27);
  await frames('launch', 1, 0, 14, 28);
  await browser.close();
})();
