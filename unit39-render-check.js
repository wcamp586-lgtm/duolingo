// 列出 unit 39 内所有节点的 data-test token，找 1/1 review 节点的真实标记
const { chromium } = require('/Users/fengzhao/Projects/duolingo/node_modules/playwright');
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: false, viewport: { width: 1280, height: 900 }, args: ['--no-proxy-server'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.duolingo.com/learn', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.goto('https://www.duolingo.com/sections', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.locator('button', { hasText: '复习' }).nth(1).click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(10000);
  const info = await page.evaluate(() => {
    const unit = document.querySelector('[data-test~="skill-path-unit-39"]');
    if (!unit) return { err: 'no unit 39' };
    const nodes = [...unit.querySelectorAll('[data-test*="skill-path-level"]')].map((e) => ({
      test: e.getAttribute('data-test'), tag: e.tagName.toLowerCase(),
      text: (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      y: Math.round(e.getBoundingClientRect().y),
    }));
    const states = [...unit.querySelectorAll('[data-test*="skill-path-state"]')].map((e) => e.getAttribute('data-test'));
    return { nodes, states };
  });
  console.log(JSON.stringify(info, null, 1).slice(0, 3000));
  await ctx.close();
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
