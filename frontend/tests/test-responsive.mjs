import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import express from '../../backend/node_modules/express/index.js';

const CHROME_PATH = '/usr/bin/google-chrome';
const FRONTEND_DIST = path.resolve('dist');

const VIEWPORTS = [
  { name: 'Desktop Large', width: 1440, height: 900 },
  { name: 'Tablet iPad', width: 768, height: 1024 },
  { name: 'Mobile iPhone', width: 390, height: 844 },
];

async function runResponsiveCheck() {
  const frontendApp = express();
  frontendApp.use(express.static(FRONTEND_DIST));
  frontendApp.get('*', (_req, res) => res.sendFile(path.join(FRONTEND_DIST, 'index.html')));

  const server = frontendApp.listen(5188);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  const results = [];

  for (const vp of VIEWPORTS) {
    await page.setViewport({ width: vp.width, height: vp.height });
    await page.goto('http://localhost:5188/login', { waitUntil: 'networkidle2' });

    const overflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });

    results.push({ viewport: vp.name, overflow, passed: !overflow });
    console.log(`[Responsive] ${vp.name} (${vp.width}x${vp.height}): Overflow = ${overflow} — ${!overflow ? 'PASS' : 'FAIL'}`);
  }

  await browser.close();
  server.close();

  const allPassed = results.every((r) => r.passed);
  console.log(`Responsive Check: ${allPassed ? 'ALL VIEWPORTS CLEAN (NO OVERFLOW)' : 'OVERFLOW DETECTED'}`);
  if (!allPassed) process.exit(1);
}

runResponsiveCheck().catch((err) => {
  console.error(err);
  process.exit(1);
});
