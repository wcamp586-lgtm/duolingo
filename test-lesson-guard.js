// 离线验证 lesson-guard：不联网、不用 profile。
// 场景 1：法语 radio 后落到只有 token、没有 challenge 容器的页面 -> 非题目页。
// 场景 2：同一屏超过无进展上限 -> 抛出带页面状态和秒数的错误。
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const guard = require('./lesson-guard.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' -> ' + e.message); }
};

const nonQuestion = {
  url: '/lesson', hasChallenge: false, hasLoading: false, hasStoryCover: false,
  hasStoriesElement: false, hasEndButton: false, hasQuitButton: true,
  nextEnabled: false, nextText: '', text: 'CONVERSATIONS AVEC ZARI 选择配对',
};

async function main() {
  t('有 challenge 容器 -> question', () => {
    assert.equal(guard.classifyPage({ ...nonQuestion, hasChallenge: true }), 'question');
  });
  t('loading-screen -> loading', () => {
    assert.equal(guard.classifyPage({ ...nonQuestion, hasLoading: true }), 'loading');
  });
  t('story-start -> story-cover', () => {
    assert.equal(guard.classifyPage({ ...nonQuestion, hasStoryCover: true }), 'story-cover');
  });
  t('quit-button + 无 challenge 容器 -> non-question', () => {
    assert.equal(guard.classifyPage(nonQuestion), 'non-question');
  });
  t('结算按钮 -> settlement', () => {
    assert.equal(guard.classifyPage({ ...nonQuestion, hasEndButton: true }), 'settlement');
  });
  t('describePage 写清非题目页和 URL', () => {
    const text = guard.describePage(nonQuestion);
    assert.match(text, /非题目页/);
    assert.match(text, /quit-button/);
    assert.match(text, /\/lesson/);
  });

  let now = 0;
  const clock = () => now;
  t('未到上限不报超时，到上限才报', () => {
    const g = guard.createProgressGuard(45000, clock);
    now = 0;
    assert.equal(g.expired(), false);
    now = 44999;
    assert.equal(g.expired(), false);
    now = 45000;
    assert.equal(g.expired(), true);
  });
  t('touch() 重置无进展计时', () => {
    now = 0;
    const g = guard.createProgressGuard(45000, clock);
    now = 45000;
    g.touch();
    now = 89999;
    assert.equal(g.expired(), false);
    now = 90000;
    assert.equal(g.expired(), true);
  });
  t('超时错误包含非题目页和秒数', () => {
    now = 0;
    const g = guard.createProgressGuard(45000, clock);
    now = 45000;
    const error = guard.noProgressError(nonQuestion, g);
    assert.match(error.message, /无题页面停滞 45 秒/);
    assert.match(error.message, /非题目页/);
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div data-test="quit-button">退出</div>
      <div data-test="drawer-backdrop"></div>
      <button data-test="电话-challenge-tap-token"><span data-test="challenge-tap-token-text">电话</span></button>
      <button data-test="聚会-challenge-tap-token"><span data-test="challenge-tap-token-text">聚会</span></button>
      <div>CONVERSATIONS AVEC ZARI 选择配对</div>
    `);
    const snapshot = await guard.readPageState(page);
    t('真实 DOM：只有 token、没有 challenge 容器 -> 非题目页', () => {
      assert.equal(snapshot.hasChallenge, false);
      assert.equal(snapshot.hasQuitButton, true);
      assert.equal(snapshot.nextEnabled, false);
      assert.equal(guard.classifyPage(snapshot), 'non-question');
      assert.match(guard.describePage(snapshot), /CONVERSATIONS AVEC ZARI/);
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
