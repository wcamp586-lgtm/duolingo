const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    headless: false, viewport:{width:1280,height:900}, args:['--no-proxy-server'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  let uid=null;
  page.on('response', r => { const m=r.url().match(/\/users\/(\d+)\?/); if(m) uid=m[1]; });
  await page.goto('https://www.duolingo.com/learn', { waitUntil:'domcontentloaded' });
  await sleep(8000);
  const r = await page.evaluate(async (id) => {
    const out = {};
    const res = await fetch('/2023-05-23/users/' + id + '?fields=currentCourseId,courses', { credentials:'include' });
    const j = await res.json();
    out.before = j.currentCourseId;
    out.courses = (j.courses||[]).map(c => c.id).slice(0,6);
    return out;
  }, uid);
  console.log('当前:', JSON.stringify(r));
  // 试切换
  const sw = await page.evaluate(async (id) => {
    const tries = [
      ['/2023-05-23/users/' + id + '/courses/DUOLINGO_EN_ZH-CN/select', 'POST'],
      ['/2023-05-23/users/' + id + '/courses/DUOLINGO_EN_ZH-CN', 'PUT'],
    ];
    const out = [];
    for (const [url, method] of tries) {
      try {
        const res = await fetch(url, { method, credentials:'include' });
        out.push({ url, method, status: res.status });
        if (res.ok) break;
      } catch (e) { out.push({ url, method, err: e.message }); }
    }
    return out;
  }, uid);
  console.log('切换尝试:', JSON.stringify(sw, null, 1));
  const after = await page.evaluate(async (id) => {
    const res = await fetch('/2023-05-23/users/' + id + '?fields=currentCourseId', { credentials:'include' });
    return (await res.json()).currentCourseId;
  }, uid);
  console.log('切换后:', after);
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
