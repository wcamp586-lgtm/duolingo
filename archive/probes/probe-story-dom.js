const { chromium } = require('playwright');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'profile'), {
    headless: false, viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--disable-session-crashed-bubble', '--no-first-run'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  let stories = null;
  page.on('response', async (r) => {
    if (!r.url().includes('stories.duolingo.com')) return;
    try { const j = await r.json(); if (Array.isArray(j.elements)) stories = j; } catch (e) {}
  });
  await page.goto('https://www.duolingo.com/learn', { waitUntil: 'domcontentloaded' });
  await sleep(7000);

  // 点开始（取最小的"开始"元素）
  const pos = await page.evaluate(() => {
    const els = [...document.querySelectorAll('div, a, button')]
      .filter((e) => { const t = (e.textContent||'').trim(); const r = e.getBoundingClientRect(); return (t === '开始' || t.startsWith('开始 +')) && r.width > 0 && r.width < 300; })
      .sort((a,b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width);
    if (!els[0]) return null;
    const r = els[0].getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  });
  console.log('start=' + JSON.stringify(pos));
  if (pos) { await page.mouse.click(pos.x, pos.y); await sleep(7000); }

  // 点封面「继续」
  for (let i = 0; i < 3; i++) {
    const hasChallenge = await page.evaluate(() => !!document.querySelector('[data-test*="challenge challenge-"]'));
    if (hasChallenge) break;
    try { const c = page.getByRole('button', { name: '继续' }).first(); if (await c.count()) { await c.click({ force: true }); await sleep(3500); continue; } } catch (e) {}
    break;
  }
  await sleep(3000);

  console.log('url=' + page.url());
  console.log('stories loaded=' + (stories ? stories.elements.length : 0));
  const dom = await page.evaluate(() => {
    const box = document.querySelector('[data-test*="challenge challenge-"]');
    const root = box || document.body;
    return {
      hasBox: !!box,
      boxType: box ? box.getAttribute('data-test') : null,
      text: (root.innerText || '').slice(0, 400),
      tests: [...root.querySelectorAll('[data-test]')].map(e => e.getAttribute('data-test')).filter(Boolean).slice(0, 40),
      buttons: [...root.querySelectorAll('button')].filter(e => e.getBoundingClientRect().width > 0).map(e => (e.textContent||'').trim().slice(0, 40)).slice(0, 20),
    };
  });
  console.log(JSON.stringify(dom, null, 1));
  if (stories) require('fs').writeFileSync(path.join(__dirname, 'stories-session.json'), JSON.stringify(stories, null, 1));
  await page.screenshot({ path: path.join(__dirname, 'story-dom.png') });
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
