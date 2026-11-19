const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    headless:false, viewport:{width:1280,height:900}, args:['--no-proxy-server'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.duolingo.com/learn', { waitUntil:'domcontentloaded' });
  await sleep(8000);
  const before = await page.locator('[data-test^="skill-path-level-"]').count();
  console.log('节点数:', before);

  // 点第一个可见的故事/练习节点
  const node = page.locator('[data-test="skill-path-level-1 skill-path-level-story"]').first();
  const cnt = await node.count();
  console.log('story 节点: count=' + cnt);
  if (!cnt) { await ctx.close(); return; }
  await node.scrollIntoViewIfNeeded().catch(()=>{});
  await sleep(500);
  await node.click({ timeout: 5000, force: true }).catch(e => console.log('click err', e.message));
  await sleep(2500);

  const after = await page.evaluate(() => ({
    url: location.pathname,
    tests: [...new Set([...document.querySelectorAll('[data-test]')].map(e=>e.getAttribute('data-test')))].slice(0,30),
    links: [...document.querySelectorAll('a[href*="/lesson"]')].map(a=>a.getAttribute('href')).slice(0,10),
    text: (document.body.innerText||'').replace(/\s+/g,' ').slice(0,220),
  }));
  console.log(JSON.stringify(after, null, 1));
  await page.screenshot({ path: 'probe-node.png' });
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
