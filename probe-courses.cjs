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
  const info = await page.evaluate(async (id) => {
    const out = {};
    for (const f of ['courses', 'currentCourse,courses']) {
      const res = await fetch('/2023-05-23/users/' + id + '?fields=' + f, { credentials: 'include' });
      if (!res.ok) { out[f] = { status: res.status }; continue; }
      const j = await res.json();
      const cs = j.courses || (j.currentCourse && j.currentCourse.courses);
      out[f] = {
        keys: Object.keys(j),
        coursesType: Array.isArray(cs) ? 'array' : typeof cs,
        courses: Array.isArray(cs) ? cs.map(c => ({ id: c.id, title: c.title, learningLanguage: c.learningLanguage, hasPath: Array.isArray(c.pathSectioned), sections: (c.pathSectioned||[]).length })).slice(0, 10)
          : (cs ? Object.keys(cs).slice(0, 10) : null),
      };
    }
    return out;
  }, uid);
  console.log(JSON.stringify(info, null, 1).slice(0, 1800));
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
