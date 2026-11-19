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
  await sleep(9000);
  const c = await page.evaluate(async (id) => {
    const res = await fetch('/2023-05-23/users/' + id + '?fields=currentCourse', { credentials: 'include' });
    return res.ok ? (await res.json()).currentCourse : null;
  }, uid);
  fs.writeFileSync('course-path.json', JSON.stringify(c));
  console.log('course=' + c.id);
  let shown = 0;
  for (const s of c.pathSectioned) for (const u of s.units||[]) for (const [li,l] of (u.levels||[]).entries()) {
    if (l.state !== 'passed' || !['skill','story'].includes(l.type)) continue;
    if (s.index !== 1) continue;
    if (++shown > 5) break;
    console.log(`\ns${s.index} u${u.unitIndex} l${li} ${l.type} "${l.debugName||''}"`);
    console.log('  meta=' + JSON.stringify(l.pathLevelMetadata||{}).slice(0,260));
    console.log('  fin/total=' + l.finishedSessions + '/' + l.totalSessions + ' inProgress=' + l.isInProgressSequence);
  }
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
