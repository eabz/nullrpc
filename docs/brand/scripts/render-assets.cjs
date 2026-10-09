#!/usr/bin/env node
/* Render production PNGs from the outlined SVG masters. Requires sharp. */
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const assets = path.resolve(__dirname, '../assets');

async function main() {
  const exports = [
    ['logo-dark', 'logo-dark', 880], ['logo-light', 'logo-light', 880],
    ['logo-mono-dark', 'logo-mono-dark', 880], ['logo-mono-light', 'logo-mono-light', 880],
    ['social-card', 'social-card', 1200], ['banner', 'banner', 1600],
    ['brand-board', 'brand-board', 1600], ['avatar', 'avatar-512', 512],
    ['avatar', 'avatar-1024', 1024], ['avatar', 'apple-touch-icon', 180],
    ['favicon', 'favicon-32', 32], ['favicon', 'favicon-48', 48]
  ];
  for (const [source, name, width] of exports) {
    await sharp(path.join(assets, `${source}.svg`), { density: 192 })
      .resize(width).png().toFile(path.join(assets, `${name}.png`));
  }
  // Render the optical master directly for the smallest favicon.
  await sharp(path.join(assets, 'mark-small.svg'))
    .flatten({ background: '#0A0D12' }).png().toFile(path.join(assets, 'favicon-16.png'));
  const files = fs.readdirSync(assets).filter(x => /\.(svg|png|webp|ico)$/.test(x)).sort();
  const manifest = [];
  for (const file of files) {
    if (file.endsWith('.ico')) continue;
    const m = await sharp(path.join(assets, file)).metadata();
    manifest.push({ file, format: m.format, width: m.width, height: m.height, alpha: m.hasAlpha });
  }
  fs.writeFileSync(path.join(assets, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Rendered ${exports.length + 1} PNGs and wrote asset manifest.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
