const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    headless:false, viewport:{width:1280,height:900}, args:['--no-proxy-server'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  const out = [];
  page.on('response', async r => {
    if (!/\/2023-05-23\/sessions/.test(r.url())) return;
    try {
      const j = await r.json();
      out.push({ url: r.url().replace('https://www.duolingo.com','').slice(0,60),
                 keys: j && typeof j==='object' ? Object.keys(j).slice(0,10) : typeof j,
                 challenges: j && Array.isArray(j.challenges) ? j.challenges.length : null,
                 type: j && j.type });
    } catch (e) { out.push({ url: r.url().slice(0,60), err: e.message }); }
  });
  await page.goto('https://www.duolingo.com/lesson/unit/24/legendary/3', { waitUntil:'domcontentloaded' });
  await sleep(6000);
  // 点确认页的「继续」
  const b = page.locator('[data-test="player-next"]').first();
  if (await b.count()) { await b.click().catch(()=>{}); console.log('clicked player-next'); }
  await sleep(8000);
  console.log('URL:', page.url());
  console.log('sessions 响应:', JSON.stringify(out, null, 1));
  const dom = await page.evaluate(() => ({
    tests: [...new Set([...document.querySelectorAll('[data-test]')].map(e=>e.getAttribute('data-test')))].slice(0,12),
    text: (document.body.innerText||'').replace(/\s+/g,' ').slice(0,120),
  }));
  console.log('页面:', JSON.stringify(dom));
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
