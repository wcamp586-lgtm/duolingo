const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    headless:false, viewport:{width:1280,height:900}, args:['--no-proxy-server'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  const reqs = [];
  page.on('response', r => { if (/session/i.test(r.url()) && r.url().includes('duolingo')) reqs.push(r.url().replace('https://www.duolingo.com','') + ' ' + (r.headers()['content-type']||'')); });
  await page.goto('https://www.duolingo.com/lesson/unit/24/legendary/3', { waitUntil:'domcontentloaded' });
  await sleep(15000);
  console.log('url=' + page.url());
  console.log('session 请求:', JSON.stringify(reqs.slice(0,5), null, 1));
  const info = await page.evaluate(() => ({
    tests: [...new Set([...document.querySelectorAll('[data-test]')].map(e=>e.getAttribute('data-test')))].slice(0,16),
    text: (document.body.innerText||'').replace(/\s+/g,' ').slice(0,200),
  }));
  console.log(JSON.stringify(info, null, 1));
  await page.screenshot({ path: 'probe-lesson.png' });
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
