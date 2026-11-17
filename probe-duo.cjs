const { chromium } = require('playwright');
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    headless: false, viewport:{width:1280,height:900}, args:['--no-proxy-server'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.duolingo.com/learn', { waitUntil:'domcontentloaded' });
  await new Promise(r=>setTimeout(r,9000));
  const info = await page.evaluate(() => {
    const d = window.duo;
    const keys = d ? Object.keys(d) : [];
    let pathInfo = null;
    try {
      const s = JSON.stringify(d);
      pathInfo = { hasPath: s.includes('pathSectioned'), size: s.length };
    } catch(e) { pathInfo = { err: e.message }; }
    return { duoKeys: keys.slice(0,30), pathInfo };
  });
  console.log(JSON.stringify(info,null,1));
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
