const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    headless:false, viewport:{width:1280,height:900}, args:['--no-proxy-server'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.duolingo.com/learn', { waitUntil:'domcontentloaded' });
  await sleep(9000);
  const info = await page.evaluate(() => ({
    url: location.pathname,
    units: [...document.querySelectorAll('[data-test^="skill-path-unit-"]')].map(e=>e.getAttribute('data-test')),
    levels: [...document.querySelectorAll('[data-test*="skill-path-level-"]')].map(e=>e.getAttribute('data-test')).slice(0,10),
    pathCount: document.querySelectorAll('[data-test="skill-path"]').length,
  }));
  console.log(JSON.stringify(info, null, 1).slice(0,800));
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
