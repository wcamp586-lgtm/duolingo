// 离线验证电台专用配对：同词键左右各一才点；多候选不猜；每对必须看到反馈。
// 不联网、不使用 profile/；只启无头浏览器加载本地 HTML。
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const row = (y) => `style="position:absolute;left:363px;top:${y}px;width:200px;height:50px"`;
const rowR = (y) => `style="position:absolute;left:648px;top:${y}px;width:200px;height:50px"`;

function pairButton(key, text, left, y, feedback) {
  const style = left ? row(y) : rowR(y);
  const onclick = feedback
    ? `onclick="window.clicks=(window.clicks||0)+1;window.pc=window.pc||{};window.pc['${key}']=(window.pc['${key}']||0)+1;if(window.pc['${key}']>=2){document.querySelectorAll('[data-test=\\'${key}-challenge-tap-token\\']').forEach(b=>b.disabled=true);if(!document.getElementById('nextq')){const d=document.createElement('div');d.id='nextq';d.textContent='下一题';document.body.appendChild(d);}}"`
    : `onclick="window.clicks=(window.clicks||0)+1"`;
  return `<button data-test="${key}-challenge-tap-token" ${style} ${onclick}>${text}</button>`;
}

async function main() {
  const radioTap = require('./radio-tap.js');
  let pass = 0, fail = 0;
  const t = async (name, fn) => {
    try { await fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + ' -> ' + e.message); }
  };

  const browser = await chromium.launch({ headless: true });
  try {
    await t('同词键左右各一：逐对点击并确认反馈 → done', async () => {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1280, height: 720 });
      const keys = ['演出', '戏剧', '演员', '角色'];
      const html = `<div>选择配对</div>${keys.map((k, i) => pairButton(k, String(i + 1), true, 200 + i * 70, true)).join('')}${keys.map((k, i) => pairButton(k, String(i + 5) + ' ' + k, false, 200 + i * 70, true)).join('')}`;
      await page.setContent(html);
      const r = await radioTap.run(page, async () => {});
      assert.equal(r.status, 'partial');
      assert.ok(r.next && r.next.text.includes('下一题'));
      assert.equal(await page.evaluate(() => window.clicks), 8);
      await page.close();
    });

    await t('同词键出现三个：RADIO_TAP_AMBIGUOUS，零点击', async () => {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1280, height: 720 });
      const html = `<div>选择配对</div>${pairButton('演出', '1', true, 200, true)}${pairButton('演出', '5 演出', false, 200, true)}${pairButton('演出', '9 演出', false, 270, true)}`;
      await page.setContent(html);
      const r = await radioTap.run(page, async () => {});
      assert.equal(r.status, 'blocked');
      assert.match(r.error, /RADIO_TAP_AMBIGUOUS key=演出 count=3/);
      assert.equal(await page.evaluate(() => window.clicks || 0), 0);
      await page.close();
    });

    await t('点后没有失活反馈：RADIO_TAP_NO_FEEDBACK，只点一对就停', async () => {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1280, height: 720 });
      const keys = ['演出', '戏剧'];
      const html = `<div>选择配对</div>${keys.map((k, i) => pairButton(k, String(i + 1), true, 200 + i * 70, false)).join('')}${keys.map((k, i) => pairButton(k, String(i + 5) + ' ' + k, false, 200 + i * 70, false)).join('')}`;
      await page.setContent(html);
      const r = await radioTap.run(page, async () => {});
      assert.equal(r.status, 'blocked');
      assert.match(r.error, /RADIO_TAP_NO_FEEDBACK/);
      assert.equal(await page.evaluate(() => window.clicks), 2);
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
