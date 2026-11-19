const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    headless:false, viewport:{width:1280,height:900}, args:['--no-proxy-server'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  let uid = null;
  const seen = [];
  page.on('response', r => {
    const m = r.url().match(/\/users\/(\d+)\?/); if (m) uid = m[1];
    if (/courses|path/i.test(r.url()) && r.url().includes('duolingo.com')) seen.push(r.url().replace('https://www.duolingo.com',''));
  });
  await page.goto('https://www.duolingo.com/learn', { waitUntil:'domcontentloaded' });
  await sleep(9000);
  console.log('uid=' + uid);
  console.log('相关请求:', JSON.stringify([...new Set(seen)].slice(0,12), null, 1));

  for (const q of ['currentCourse,learningLanguages', 'learningLanguages']) {
    const r = await page.evaluate(async (f) => {
      const res = await fetch('/2023-05-23/users/' + window.__uid + '?fields=' + f, { credentials: 'include' }).catch(()=>null);
      return res ? res.status : 0;
    }, q).catch(() => 0);
  }
  // 直接看 currentCourse 顶层
  const info = await page.evaluate(async (id) => {
    const res = await fetch('/2023-05-23/users/' + id + '?fields=learningLanguages', { credentials: 'include' });
    if (!res.ok) return { status: res.status };
    const j = await res.json();
    return { keys: Object.keys(j), ll: JSON.stringify(j.learningLanguages || j).slice(0, 300) };
  }, uid);
  console.log('learningLanguages:', JSON.stringify(info));
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
