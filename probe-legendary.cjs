const { chromium } = require('playwright');
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    headless:false, viewport:{width:1280,height:900}, args:['--no-proxy-server'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  for (const p of ['/lesson/unit/13/legendary/0','/lesson/unit/13/legendary/1','/lesson/unit/13/legendary/2']) {
    await page.goto('https://www.duolingo.com'+p, {waitUntil:'domcontentloaded'}).catch(()=>{});
    await new Promise(r=>setTimeout(r,5000));
    const info = await page.evaluate(() => ({
      path: location.pathname,
      tests: [...new Set([...document.querySelectorAll('[data-test]')].map(e=>e.getAttribute('data-test')))].slice(0,20),
      text: (document.body.innerText||'').replace(/\s+/g,' ').slice(0,160),
    }));
    console.log(JSON.stringify(info));
  }
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
