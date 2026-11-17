const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    headless:false, viewport:{width:1280,height:900}, args:['--no-proxy-server'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  for (const p of ['/lesson/unit/3/legendary/1','/lesson/unit/3/legendary/2','/lesson/unit/5/legendary/1']) {
    await page.goto('https://www.duolingo.com'+p, {waitUntil:'domcontentloaded'}).catch(()=>{});
    await sleep(9000);
    const info = await page.evaluate(() => ({
      path: location.pathname,
      tests: [...new Set([...document.querySelectorAll('[data-test]')].map(e=>e.getAttribute('data-test')))].slice(0,14),
      text: (document.body.innerText||'').replace(/\s+/g,' ').slice(0,150),
    }));
    console.log(JSON.stringify(info));
  }
  await page.screenshot({path:'probe-stage2.png'});
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
