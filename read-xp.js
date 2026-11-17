const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Playwright 自带浏览器找不到时（HOME 变了、缓存没了）用系统 Chrome，只动项目 profile/，不碰用户的默认 Chrome
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'profile'), {
    executablePath: fs.existsSync(SYSTEM_CHROME) ? SYSTEM_CHROME : undefined,
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--disable-session-crashed-bubble', '--no-first-run', '--no-proxy-server'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://www.duolingo.com/learn', { waitUntil: 'domcontentloaded' });
  await sleep(6000);
  const out = await page.evaluate(async () => {
    const r = await fetch('/2023-05-23/users/769346152?fields=totalXp,streak,courses', { credentials: 'include' });
    const j = await r.json();
    return { totalXp: j.totalXp, streak: j.streak, courses: (j.courses || []).map((c) => c.learningLanguage + ':' + c.xp) };
  });
  console.log(JSON.stringify(out));
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
