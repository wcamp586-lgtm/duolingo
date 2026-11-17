const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    headless:false, viewport:{width:1280,height:900}, args:['--no-proxy-server'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  let uid = null;
  page.on('response', r => { const m = r.url().match(/\/users\/(\d+)\?/); if (m) uid = m[1]; });
  await page.goto('https://www.duolingo.com/learn', { waitUntil:'domcontentloaded' });
  await sleep(9000);
  const c = await page.evaluate(async (id) => {
    const res = await fetch('/2023-05-23/users/' + id + '?fields=currentCourse', { credentials: 'include' });
    return res.ok ? (await res.json()).currentCourse : null;
  }, uid);
  if (!c) { console.log('no course'); await ctx.close(); return; }
  console.log('course=' + c.id + ' sections=' + (c.pathSectioned||[]).length);
  const stat = {};
  for (const s of c.pathSectioned||[]) {
    for (const u of s.units||[]) {
      for (const [li, l] of (u.levels||[]).entries()) {
        const k = l.type + '/' + l.state;
        stat[k] = (stat[k]||0) + 1;
      }
    }
  }
  console.log('类型/状态统计:', JSON.stringify(stat, null, 1));
  // 前两个 section 的概览
  (c.pathSectioned||[]).slice(0,3).forEach(s => {
    console.log(`section ${s.index} units=${(s.units||[]).length} 首单元 unitIndex=${s.units&&s.units[0]&&s.units[0].unitIndex}`);
  });
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
