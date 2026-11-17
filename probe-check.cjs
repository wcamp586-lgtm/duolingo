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
  const sec = c.pathSectioned.find(s => s.index === 2);
  const u46 = sec.units.find(u => u.unitIndex === 46);
  console.log('section2 unit46 levels:');
  u46.levels.forEach((l,i)=>console.log(`  l${i} ${l.type.padEnd(10)} ${l.state.padEnd(10)} ${l.debugName||''}`));
  // 顺便统计：section2 里还有多少 passed 的 skill/story
  let pending = 0, done = 0;
  for (const u of sec.units) for (const [i,l] of u.levels.entries()) {
    if (!['skill','story'].includes(l.type)) continue;
    if (l.state === 'passed') pending++;
    if (l.state === 'legendary') done++;
  }
  console.log(`\nsection2 传奇进度: legendary=${done} passed=${pending}`);
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
