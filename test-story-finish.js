// 离线验证故事收尾的边界与停滞：
// 1) 4 步之后仍在读、每一行新末尾都能推动，直到结算控件出现；
// 2) 点击后页面没有真实变化 → 停滞一次即停，不盲点；
// 3) 阅读行用尽仍无结算 → 在 session 长度边界（max-clicks）安全退出。
// 不联网、不使用 profile/；只启无头浏览器加载本地 HTML。
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

async function main() {
  const autoRunner = require('./auto-runner.js');
  let pass = 0, fail = 0;
  const t = async (name, fn) => {
    try { await fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + ' -> ' + e.message); }
  };

  const html = (withDone) => `
    <div>${'固定前部文本 '.repeat(20)}</div>
    <div data-test="stories-element"><div id="line1">ligne 1</div></div>
    <button id="next" data-test="stories-player-continue" onclick="
      window.clicks=(window.clicks||0)+1;
      const d=document.createElement('div'); d.textContent='ligne '+(window.clicks+1);
      document.querySelector('[data-test=stories-element]').appendChild(d);
      ${withDone ? "if(window.clicks>=6){document.getElementById('next').style.display='none';const b=document.createElement('button');b.textContent='完成';b.setAttribute('data-test','stories-player-done');b.onclick=()=>{location.href='https://www.duolingo.com/learn'};document.body.appendChild(b);}" : ''}
    ">继续</button>
  `;

  const browser = await chromium.launch({ headless: true });
  try {
    await t('4 步之后继续读，新末尾推动直到结算控件出现', async () => {
      const page = await browser.newPage();
      await page.route('https://www.duolingo.com/learn', (route) => route.fulfill({ contentType: 'text/html', body: '<html><body>learn</body></html>' }));
      await page.setContent(html(true));
      const result = await autoRunner.finishStory(page, async () => {}, { elements: Array.from({ length: 29 }, (_, i) => ({ lineIndex: i })) });
      assert.equal(result, 'advanced');
      await page.close();
    });

    await t('已知按钮先 disabled、5 秒后自然启用：等到启用再点，期间不计 no-change', async () => {
      const page = await browser.newPage();
      let clicks = 0;
      await page.exposeFunction('__mark', () => { clicks++; });
      await page.route('https://www.duolingo.com/learn', (route) => route.fulfill({ contentType: 'text/html', body: '<html><body>learn</body></html>' }));
      await page.setContent(`
        <div>${'固定前部文本 '.repeat(20)}</div>
        <button id="next" data-test="stories-player-continue" disabled onclick="__mark(); location.href='https://www.duolingo.com/learn'">继续</button>
        <script>setTimeout(() => { document.getElementById('next').disabled = false; }, 5000);</script>
      `);
      const result = await autoRunner.finishStory(page, async () => {}, { elements: [{}] });
      assert.equal(result, 'advanced');
      assert.equal(clicks, 1);
      await page.close();
    });

    await t('点击后页面没变化：停滞一次即停，不盲点', async () => {
      const page = await browser.newPage();
      await page.setContent(`<div>${'固定前部文本 '.repeat(20)}</div><button data-test="stories-player-continue">继续</button>`);
      const result = await autoRunner.finishStory(page, async () => {}, { elements: [{}] });
      assert.match(result, /^no-change/);
      await page.close();
    });

    await t('阅读行用尽仍无结算：按 session 长度边界安全退出', async () => {
      const page = await browser.newPage();
      await page.setContent(html(false));
      const result = await autoRunner.finishStory(page, async () => {}, { elements: [{}, {}] });
      assert.equal(result, 'max-clicks');
      assert.equal(await page.evaluate(() => window.clicks), 8);
      await page.close();
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
