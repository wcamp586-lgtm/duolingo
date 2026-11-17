const { chromium } = require('playwright');
const path = require('path');

const USER_DATA = path.join(__dirname, 'profile');

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA, {
    headless: false,
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://www.duolingo.com/', { waitUntil: 'domcontentloaded' });
  console.log('BROWSER_OPEN');

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const cookies = await ctx.cookies('https://www.duolingo.com');
    if (cookies.find((c) => c.name === 'jwt_token')) {
      await new Promise((r) => setTimeout(r, 3000));
      const info = await page.evaluate(() => ({ url: location.href, title: document.title }));
      console.log('LOGIN_OK ' + JSON.stringify(info));
      await ctx.close();
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error('TIMEOUT');
  await ctx.close();
  process.exit(1);
})();
