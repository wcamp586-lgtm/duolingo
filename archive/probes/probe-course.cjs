const { chromium } = require('playwright');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    headless:false, viewport:{width:1280,height:900}, args:['--no-proxy-server'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  let uid = null;
  page.on('response', r => { const m = r.url().match(/\/users\/(\d+)\?/); if (m) uid = m[1]; });
  await page.goto('https://www.duolingo.com/learn', { waitUntil:'domcontentloaded' });
  await sleep(8000);
  const data = await page.evaluate(async (id) => {
    const res = await fetch('/2023-05-23/users/' + id + '?fields=currentCourse', { credentials: 'include' });
    return res.ok ? res.json() : null;
  }, uid);
  const c = data && data.currentCourse;
  if (!c) { console.log('no course'); await ctx.close(); return; }
  fs.writeFileSync('course-path.json', JSON.stringify(c));
  console.log('course id=' + c.id + ' sections=' + (c.pathSectioned||[]).length);
  const sec0 = (c.pathSectioned||[])[0];
  if (sec0) {
    console.log('section keys: ' + Object.keys(sec0).join(','));
    console.log('section0: index=' + sec0.index + ' type=' + sec0.type + ' units=' + (sec0.units||[]).length);
    const u0 = (sec0.units||[])[0];
    if (u0) {
      console.log('unit keys: ' + Object.keys(u0).join(','));
      console.log('unit0: unitIndex=' + u0.unitIndex + ' levels=' + (u0.levels||[]).length);
      const l0 = (u0.levels||[])[0];
      if (l0) console.log('level keys: ' + Object.keys(l0).join(',') + '\nlevel0: ' + JSON.stringify({type:l0.type,state:l0.state,id:l0.id}).slice(0,200));
    }
  }
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
