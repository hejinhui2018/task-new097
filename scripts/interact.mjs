import { chromium } from 'playwright-core';

const exe = process.argv[2];
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1360, height: 1500 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// 1) 候选比较出现
await page.getByRole('button', { name: '候选：停用 探针 P6' }).click();
await page.waitForTimeout(200);
const cmp = await page.locator('.cmp-box').innerText();
console.log('CMP:', cmp.replace(/\n/g, ' | '));

// 2) 采用 → 可放行
await page.getByRole('button', { name: '采用该候选（可撤销）' }).click();
await page.waitForTimeout(300);
const hero = await page.locator('.verdict .hero').innerText();
console.log('VERDICT AFTER ADOPT:', hero);
const reason = await page.locator('.verdict ul').innerText();
console.log('REASONS:', reason.replace(/\n/g, ' | '));

// 3) 游标：在图表命中区移动
const svg = page.locator('.chart-svg').first();
const box = await svg.boundingBox();
await page.mouse.move(box.x + box.width * 0.55, box.y + 200);
await page.waitForTimeout(200);
const tip = await page.locator('.chart-tooltip').count();
const cursorRows = await page.locator('table.cursor tbody tr').count();
console.log('TOOLTIP VISIBLE:', tip === 1, 'CURSOR ROWS:', cursorRows);
const firstRow = await page.locator('table.cursor tbody tr').first().innerText();
console.log('CURSOR ROW1:', firstRow.replace(/\t/g, ' '));
await page.screenshot({ path: '/tmp/shot-adopted.png', fullPage: false });

// 4) 撤销 → 回到悬置
await page.getByRole('button', { name: /撤销/ }).click();
await page.waitForTimeout(300);
console.log('VERDICT AFTER UNDO:', await page.locator('.verdict .hero').innerText());

// 5) 自动识别保温段（刷新恢复后仍可工作）
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(400);
console.log('AFTER RELOAD HERO:', await page.locator('.verdict .hero').innerText());
const ls = await page.evaluate(() => localStorage.getItem('hpr-review-state-v1'));
console.log('PERSISTED BYTES:', ls.length);

console.log('PAGE ERRORS:', JSON.stringify(errors));
await browser.close();
