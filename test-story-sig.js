// 离线复现并修正 storyUiSig 漏判：故事阅读器在底部追加行时，
// 旧签名（路由 + body 前 80 字符 + 按钮存在数量）不变 → 误判 no-change；
// 新签名带文本长度/stories-element 尾部/按钮状态，应判为变化。
// 不联网、不使用 profile/；只启无头浏览器加载本地 HTML。
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

async function main() {
  const guard = require('./lesson-guard.js');
  const autoRunner = require('./auto-runner.js');
  let pass = 0, fail = 0;
  const t = async (name, fn) => {
    try { await fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + ' -> ' + e.message); }
  };

  const oldSig = async (page) => {
    const s = await guard.readPageState(page);
    const presence = [];
    for (const spec of [
      '[data-test="stories-player-done"]',
      '[data-test="stories-player-continue"]',
      '[data-test="legendary-session-end-continue"]',
      'button:has-text("结束课程")',
    ]) presence.push(await page.locator(spec).count());
    return guard.classifyPage(s) + '|' + s.url + '|' + (s.text || '').slice(0, 80) + '|' + presence.join(',');
  };

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div>${'前部固定文本 '.repeat(12)}</div>
      <div data-test="stories-element"><div id="line1">Ligne un</div></div>
      <button data-test="stories-player-continue">继续</button>
    `);
    const old1 = await oldSig(page);
    const new1 = await autoRunner.storyUiSig(page);

    await t('追加一行后，旧签名不变（复现漏判）', async () => {
      await page.evaluate(() => {
        document.querySelector('#line1').insertAdjacentHTML('afterend', '<div>Ligne deux — 末尾追加的内容</div>');
      });
      const old2 = await oldSig(page);
      assert.equal(old2, old1);
    });

    await t('追加一行后，新签名变化（修复漏判）', async () => {
      const new2 = await autoRunner.storyUiSig(page);
      assert.notEqual(new2, new1);
    });
  } finally {
    await browser.close();
  }

  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
