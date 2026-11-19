const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext('/Users/fengzhao/Projects/duolingo/profile', {
    headless:false, viewport:{width:1280,height:900}, args:['--no-proxy-server'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.duolingo.com/learn', { waitUntil:'domcontentloaded' });
  await sleep(8000);

  // 滚到故事节点
  const info = await page.evaluate(() => {
    const n = document.querySelector('[data-test="skill-path-level-1 skill-path-level-story"]');
    if (!n) return { found:false };
    const r0 = n.getBoundingClientRect();
    n.scrollIntoView({ block:'center' });
    const r1 = n.getBoundingClientRect();
    return { found:true, before:{y:Math.round(r0.y)}, after:{x:Math.round(r1.x),y:Math.round(r1.y),w:Math.round(r1.width),h:Math.round(r1.height)},
      html: n.outerHTML.slice(0,400) };
  });
  console.log('滚动:', JSON.stringify(info));
  await sleep(1200);

  const node = page.locator('[data-test="skill-path-level-1 skill-path-level-story"]').first();
  try { await node.click({ timeout: 5000 }); console.log('click ok'); }
  catch (e) { console.log('click err:', e.message.split('\n')[0]); }
  await sleep(2500);

  const after = await page.evaluate(() => ({
    url: location.pathname,
    tests: [...new Set([...document.querySelectorAll('[data-test]')].map(e=>e.getAttribute('data-test')))].filter(t=>/legendary|story|modal|choice|start|path/.test(t)).slice(0,20),
    text: (document.body.innerText||'').replace(/\s+/g,' ').slice(0,200),
  }));
  console.log('点击后:', JSON.stringify(after, null, 1));
  await page.screenshot({ path: 'probe-node2.png' });
  await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
