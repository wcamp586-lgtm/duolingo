const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    headless: false, viewport:{width:1280,height:900}, args:['--no-proxy-server'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  let uid=null;
  page.on('response', r => { const m=r.url().match(/\/users\/(\d+)\?/); if(m) uid=m[1]; });
  await page.goto('https://www.duolingo.com/learn', { waitUntil:'domcontentloaded' });
  await sleep(9000);
  const info = await page.evaluate(async () => {
    const out = { url: location.href };
    // 页面上有没有课程切换入口
    const btn = document.querySelector('[data-test="courses-menu"]');
    out.hasCoursesMenu = !!btn;
    return out;
  });
  console.log(JSON.stringify(info));
  // 点课程菜单看切换 UI
  const menu = page.locator('[data-test="courses-menu"]').first();
  if (await menu.count()) {
    await menu.click().catch(()=>{});
    await sleep(2000);
    const dump = await page.evaluate(() => ({
      tests: [...new Set([...document.querySelectorAll('[data-test]')].map(e=>e.getAttribute('data-test')))].slice(0,25),
      text: (document.body.innerText||'').replace(/\s+/g,' ').slice(0,300),
    }));
    console.log(JSON.stringify(dump, null, 1).slice(0, 1200));
    await page.screenshot({ path: 'probe-courses.png' });
  }
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
