import { chromium } from 'playwright-core';

const exe = process.argv[2];
const url = 'http://localhost:4173/';
const shot = process.argv[3] ?? '/tmp/shot.png';
const theme = process.argv[4] ?? 'light';

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1360, height: 1500 }, deviceScaleFactor: 2 });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: 'networkidle' });
if (theme === 'dark') {
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(300);
}
await page.waitForTimeout(500);
await page.screenshot({ path: shot, fullPage: true });
console.log('errors:', JSON.stringify(errors, null, 2));
await browser.close();
