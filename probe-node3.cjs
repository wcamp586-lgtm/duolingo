const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    headless:false, viewport:{width:1280,height:900}, args:['--no-proxy-server'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.duolingo.com/learn', { waitUntil:'domcontentloaded' });
  await sleep(8000);

  await page.mouse.move(650, 600);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 700); await sleep(700); }

  const state = await page.evaluate(() => {
    const ns = [...document.querySelectorAll('[data-test^="skill-path-level-"]')].map(n => {
      const r = n.getBoundingClientRect();
      return { test: n.getAttribute('data-test'), label: n.getAttribute('aria-label'),
               y: Math.round(r.y), h: Math.round(r.height), visible: r.y > 0 && r.y < 900 && r.width > 0 };
    });
    return ns;
  });
  console.log('节点:', JSON.stringify(state, null, 1));

  const target = state.find(n => n.visible && /story/.test(n.test));
  if (!target) { console.log('没有可见的故事节点'); await ctx.close(); return; }
  console.log('点击:', target.test);
  const node = page.locator(`[data-test="${target.test}"]`).first();
  try { await node.click({ timeout: 5000 }); console.log('click ok'); }
  catch (e) { console.log('click err:', e.message.split('\n')[0]); }
  await sleep(2800);

  const after = await page.evaluate(() => ({
    url: location.pathname + location.search,
    tests: [...new Set([...document.querySelectorAll('[data-test]')].map(e=>e.getAttribute('data-test')))].filter(t=>/legendary|start|modal|sheet|drawer/.test(t)).slice(0,20),
    text: (document.body.innerText||'').replace(/\s+/g,' ').slice(0,180),
  }));
  console.log('点击后:', JSON.stringify(after, null, 1));
  await page.screenshot({ path: 'probe-node3.png' });
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
