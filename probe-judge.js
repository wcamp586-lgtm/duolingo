// 一次性只读诊断：进电台直达路由，dump 判断题 session 元素结构（脱敏）
// 用途：确认 RADIO_CHOICE_UNMATCHED hits=0 的真实原因（prompt 不匹配 vs 缺 isTrue）
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ORIGIN = 'https://www.duolingo.com';
const URL_TARGET = process.argv[2] || '/lesson/unit/74/level/12';
const OUT = path.join(__dirname, 'judge-probe.json');

(async () => {
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'profile'), {
    executablePath: fs.existsSync(systemChrome) ? systemChrome : undefined,
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--no-proxy-server'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const sessions = [];
  page.on('response', async (r) => {
    try {
      const u = new URL(r.url());
      if (u.origin !== ORIGIN || !/^\/2023-05-23\/sessions/.test(u.pathname)) return;
      if (!r.ok()) return;
      const d = await r.json();
      if (!Array.isArray(d.elements)) return;
      const els = d.elements.map((e) => ({
        type: e.type,
        challengeType: e.challengeType,
        prompt: typeof e.prompt === 'string' ? e.prompt.slice(0, 90) : undefined,
        isTrue: e.isTrue,
        hasChoices: Array.isArray(e.choices),
        choicesN: Array.isArray(e.choices) ? e.choices.length : null,
        choicesSample: Array.isArray(e.choices) ? e.choices.slice(0, 4).map((c) => (typeof c === 'string' ? c.slice(0, 40) : typeof c)) : null,
        correctIndex: e.correctIndex,
        correctIndices: e.correctIndices,
        keys: Object.keys(e).sort(),
      }));
      sessions.push({ type: d.type, elements: d.elements.length, els });
    } catch (e) {}
  });

  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.goto(ORIGIN + URL_TARGET, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(12000);

  const pageInfo = await page.evaluate(() => ({
    url: location.pathname,
    text: (document.body && document.body.innerText || '').slice(0, 200),
    cards: [...document.querySelectorAll('[data-test="challenge-choice"]')].map((e) => (e.innerText || '').trim().slice(0, 20)),
  }));

  fs.writeFileSync(OUT, JSON.stringify({
    at: new Date().toISOString(),
    target: URL_TARGET,
    note: '脱敏：不写查询参数值/音频 URL/凭据',
    pageInfo,
    sessions,
  }, null, 1));
  console.log('PROBE_DONE sessions=' + sessions.length + ' cards=' + pageInfo.cards.length);
  sessions.forEach((s) => {
    console.log('SESSION type=' + s.type + ' n=' + s.elements);
    s.els.filter((e) => e.type === 'challenge').forEach((e, i) => {
      console.log('  [' + i + '] ct=' + e.challengeType + ' isTrue=' + e.isTrue + ' choices=' + e.choicesN + ' prompt=' + JSON.stringify(e.prompt));
      console.log('      keys=' + JSON.stringify(e.keys));
    });
  });
  await ctx.close();
  process.exit(0);
})().catch((e) => { console.error('PROBE_ERR ' + (e && e.message)); process.exit(1); });
