const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    headless:false, viewport:{width:1280,height:900}, args:['--no-proxy-server'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  for (const p of ['/lesson/unit/11/legendary/2','/lesson/unit/12/legendary/2','/lesson/unit/20/legendary/2']) {
    await page.goto('https://www.duolingo.com'+p, {waitUntil:'domcontentloaded'}).catch(()=>{});
    await sleep(6000);
    const info = await page.evaluate(() => ({
      path: location.pathname,
      tests: [...new Set([...document.querySelectorAll('[data-test]')].map(e=>e.getAttribute('data-test')))].slice(0,12),
      text: (document.body.innerText||'').replace(/\s+/g,' ').slice(0,120),
    }));
    console.log(JSON.stringify(info));
  }
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
