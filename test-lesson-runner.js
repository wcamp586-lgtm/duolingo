const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { step } = require('./lesson-runner.js');

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const type of ['speak', 'listenTap']) {
      await page.setContent(`
        <div data-test="challenge challenge-${type}">原题仍显示</div>
        <button data-test="player-skip"
          onclick="this.remove(); document.querySelector('#feedback').hidden = false">
          暂时跳过
        </button>
        <div id="feedback" hidden>
          <button data-test="player-next"
            onclick="document.querySelector('[data-test^=challenge]').remove(); this.remove()">
            继续
          </button>
        </div>
      `);
      const result = await step(page, {});
      assert.deepEqual(result, { status: 'skipped', type });
      assert.equal(await page.locator('[data-test^="challenge"]').count(), 0);
      console.log('  ✓ ' + type + ' advances through the skip feedback');
    }
    await page.setContent(`
      <div data-test="challenge challenge-readComprehension">提交后的旧题仍在页面上</div>
      <button data-test="player-next" aria-busy="true" disabled>...</button>
    `);
    assert.deepEqual(await step(page, {}), { status: 'waiting' });
    await page.locator('[data-test="player-next"]').evaluate(button => {
      button.removeAttribute('aria-busy');
      button.disabled = false;
      button.textContent = '继续';
      button.onclick = () => document.querySelector('[data-test^="challenge"]').remove();
    });
    assert.deepEqual(await step(page, {}), { status: 'advanced' });
    assert.equal(await page.locator('[data-test^="challenge"]').count(), 0);
    console.log('  ✓ waits for settlement feedback without answering the old question again');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
