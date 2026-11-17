const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    headless:false, viewport:{width:1280,height:900}, args:['--no-proxy-server'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  let uid = null;
  page.on('response', r => { const m = r.url().match(/\/users\/(\d+)\?/); if (m) uid = m[1]; });
  await page.goto('https://www.duolingo.com/learn', { waitUntil:'domcontentloaded' });
  await sleep(8000);
  console.log('uid=' + uid);
  const urls = [
    '/2023-05-23/courses',
    '/2023-05-23/courses/DUOLINGO_EN_ZH-CN',
    '/2023-05-23/users/' + uid + '?fields=currentCourse',
  ];
  for (const u of urls) {
    const r = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return { url, status: res.status };
        const j = await res.json();
        const keys = Object.keys(j).slice(0, 12);
        const hasPath = JSON.stringify(j).includes('pathSectioned');
        return { url, status: res.status, keys, hasPath, size: JSON.stringify(j).length };
      } catch (e) { return { url, err: e.message }; }
    }, u);
    console.log(JSON.stringify(r));
  }
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
