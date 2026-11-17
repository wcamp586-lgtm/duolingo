const { chromium } = require('playwright');
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    headless: false, viewport:{width:1280,height:900}, args:['--no-proxy-server'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.duolingo.com/learn', { waitUntil:'domcontentloaded' });
  await new Promise(r=>setTimeout(r,9000));
  const info = await page.evaluate(() => {
    const units = [...document.querySelectorAll('[data-test^="skill-path-unit-"]')];
    const out = [];
    for (const u of units) {
      const levels = [...u.querySelectorAll('[data-test*="skill-path-level-"]')].map(l => {
        const a = l.closest('a');
        return { test: l.getAttribute('data-test'), href: (a && a.getAttribute('href')) || l.getAttribute('href') || '', text: (l.innerText||'').replace(/\s+/g,' ').slice(0,30) };
      });
      out.push({ unit: u.getAttribute('data-test'), levels });
    }
    return out;
  });
  console.log(JSON.stringify(info,null,1).slice(0,2500));
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
