#!/usr/bin/env node
/* Local browser preflight and review captures. Requires playwright + Chromium.
 * Set BRAND_BROWSER_PATH if using an existing Chromium executable.
 */
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const previews = path.join(root, 'previews');
fs.mkdirSync(previews, { recursive: true });

async function main() {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BRAND_BROWSER_PATH ? { executablePath: process.env.BRAND_BROWSER_PATH } : {}) });
  const report = { viewports: [], errors: [] };
  try {
    for (const width of [1440, 768, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 960 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      page.on('pageerror', error => report.errors.push(error.message));
      page.on('requestfailed', request => report.errors.push(`${request.url()}: ${request.failure()?.errorText}`));
      await page.route(/^https?:/, route => {
        report.errors.push(`Unexpected external request: ${route.request().url()}`);
        return route.abort();
      });
      await page.goto(pathToFileURL(path.join(root, 'index.html')).href);
      await page.evaluate(() => document.fonts.ready);
      const state = await page.evaluate(() => ({
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        fonts: [...document.fonts].map(f => ({ family: f.family, status: f.status })),
        brokenImages: [...document.images].filter(i => !i.complete || !i.naturalWidth).map(i => i.src),
        links: [...document.querySelectorAll('[href],[src]')].map(e => e.href || e.src),
        ids: [...document.querySelectorAll('[id]')].map(e => e.id)
      }));
      if (state.scrollWidth > width) report.errors.push(`Page overflow at ${width}px: ${state.scrollWidth}`);
      for (const item of state.fonts) if (item.status !== 'loaded') report.errors.push(`Font not loaded: ${item.family}`);
      for (const item of state.brokenImages) report.errors.push(`Broken image: ${item}`);
      for (const link of state.links) {
        const url = new URL(link);
        if (url.protocol === 'file:') {
          if (!fs.existsSync(fileURLToPath(url))) report.errors.push(`Missing file: ${url.pathname}`);
          if (url.pathname.endsWith('/index.html') && url.hash && !state.ids.includes(decodeURIComponent(url.hash.slice(1)))) report.errors.push(`Missing anchor: ${url.hash}`);
        }
      }
      const { links, ids, ...summary } = state;
      report.viewports.push({ ...summary, localReferences: links.length });
      if (width === 1440 || width === 390) {
        const size = width === 1440 ? 'desktop' : 'mobile';
        await page.screenshot({ path: path.join(previews, `guide-${size}-cover.png`) });
        for (const section of ['identity', 'color', 'type', 'applications', 'voice']) {
          await page.locator(`#${section}`).screenshot({ path: path.join(previews, `guide-${size}-${section}.png`) });
        }
      }
      await page.close();
    }
    const page = await browser.newPage({ viewport: { width: 1120, height: 540 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(path.join(root, 'index.html')).href);
    await page.setContent(`<html><body style="margin:0;background:#0A0D12;color:#F2F4F7;font:16px monospace;padding:48px">
      <h1 style="font-size:24px;font-weight:400;margin:0 0 38px">nullrpc / actual-size rendering review</h1>
      <div style="display:flex;align-items:end;gap:48px;margin-bottom:48px">
      ${[16,20,24,32,48,64].map(n => `<div><img src="${pathToFileURL(path.join(root,'assets',n<24?'mark-small.svg':'mark-signal.svg'))}" width="${n}" height="${n}"><p>${n}px</p></div>`).join('')}
      </div><div style="display:flex;align-items:center;gap:70px">
      ${[144,220,330].map(n=>`<div><img src="${pathToFileURL(path.join(root,'assets/logo-dark.svg'))}" width="${n}"><p>${n}px lockup</p></div>`).join('')}
      </div></body></html>`);
    await page.screenshot({ path: path.join(previews, 'size-review.png') });
    await page.close();
  } finally { await browser.close(); }
  report.errors = [...new Set(report.errors)];
  fs.writeFileSync(path.join(previews, 'browser-review.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
