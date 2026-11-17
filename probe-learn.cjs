const { chromium } = require('playwright');
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    headless: false, viewport:{width:1280,height:900}, args:['--no-proxy-server'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.duolingo.com/learn', { waitUntil:'domcontentloaded' });
  await new Promise(r=>setTimeout(r,9000));
  const info = await page.evaluate(() => ({
    pathNodes: document.querySelectorAll('[data-test^="skill-path-"]').length,
    tests: [...new Set([...document.querySelectorAll('[data-test]')].map(e=>e.getAttribute('data-test')))].slice(0,50),
    globals: Object.keys(window).filter(k=>/state|data|course|store|duo|preload/i.test(k)).slice(0,20),
  }));
  console.log(JSON.stringify(info,null,1));
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
