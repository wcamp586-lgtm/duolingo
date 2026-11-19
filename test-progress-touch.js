// 离线验证：结算页「继续」和 next 点击后，同一屏不重置无进展计时，换屏才重置。
// 不联网、不用 profile/；用本地 HTML + 真实 Playwright 页面。
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const lessonGuard = require('./lesson-guard.js');
const autoRunner = require('./auto-runner.js');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' -> ' + e.message); }
};

const realCreate = lessonGuard.createProgressGuard;
let touches = 0;
lessonGuard.createProgressGuard = () => {
  const guard = realCreate(100); // 100ms 无进展即超时，避免测试等 60 秒
  const realTouch = guard.touch.bind(guard);
  guard.touch = () => { touches++; realTouch(); };
  return guard;
};

function html(kind, change) {
  const action = change
    ? "document.getElementById('screen-label').textContent='changed'; this.remove();"
    : "this.dataset.clicked='1';";
  const button = kind === 'end'
    ? `<button data-test="legendary-session-end-continue" style="width:80px;height:24px" onclick="${action}"></button>`
    : `<button data-test="player-next" style="width:80px;height:24px" onclick="${action}"></button>`;
  return `<div data-test="quit-button">退出</div><div id="screen-label">CONVERSATIONS AVEC ZARI</div>${button}`;
}

async function runCase(browser, kind, change) {
  const page = await browser.newPage();
  try {
    await page.setContent(html(kind, change));
    touches = 0;
    const target = { slot: { type: 'skill' }, data: { challenges: [] }, mode: 'normal', startedAt: Date.now() };
    const error = await Promise.race([
      autoRunner.solve(page, target, async () => {}).then(() => null, (e) => e),
      new Promise((resolve) => setTimeout(() => resolve(new Error('solve 未在 10 秒内退出')), 10000)),
    ]);
    return { error, touches };
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    await t('next 同一屏：不 touch，超时退出', async () => {
      const r = await runCase(browser, 'next', false);
      assert.ok(r.error, '应抛错退出');
      assert.match(r.error.message, /无题页面停滞/);
      assert.equal(r.touches, 0, '同一屏不应 touch');
    });
    await t('next 换屏：touch 一次，计时重置', async () => {
      const r = await runCase(browser, 'next', true);
      assert.ok(r.touches >= 1, '换屏应 touch');
    });
    await t('结算页同一屏：不 touch，超时退出', async () => {
      const r = await runCase(browser, 'end', false);
      assert.ok(r.error, '应抛错退出');
      assert.match(r.error.message, /无题页面停滞/);
      assert.equal(r.touches, 0, '同一屏不应 touch');
    });
    await t('结算页换屏：touch 一次，计时重置', async () => {
      const r = await runCase(browser, 'end', true);
      assert.ok(r.touches >= 1, '换屏应 touch');
    });
  } finally {
    await browser.close();
  }
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
