// 离线验证电台专用作答器：判断题按形状、选择题按 session 唯一匹配、提交键按 disabled→enabled。
// 不联网、不使用 profile/；只启无头浏览器加载本地 HTML。
const assert = require('node:assert/strict');
process.env.RADIO_QUIZ_DIAG_OFF = '1';
const { chromium } = require('playwright');

// 勾与叉各一段真实形状的 path（填充轮廓，来自公开图标形状）
const CHECK_D = 'M40.1 3.5c1.2 1.3 1.2 3.4-.1 4.6L19.4 27.6c-1.3 1.2-3.4 1.2-4.6-.1L1 13.8C-.2 12.5-.1 10.4 1.2 9.2c1.3-1.2 3.4-1.1 4.6.2l9.2 9.4L35.5 3.4c1.3-1.2 3.4-1.2 4.6.1z';
const CROSS_D = 'M3.3 2.9c1.1-1.1 2.9-1.1 4 0L20 15.6 32.7 2.9c1.1-1.1 2.9-1.1 4 0s1.1 2.9 0 4L24 19.6l12.7 12.7c1.1 1.1 1.1 2.9 0 4s-2.9 1.1-4 0L20 23.6 7.3 36.3c-1.1 1.1-2.9 1.1-4 0s-1.1-2.9 0-4L16 19.6 3.3 6.9c-1.1-1.1-1.1-2.9 0-4z';

const card = (text, vb, d, left) => `<div data-test="challenge-choice" role="radio" aria-checked="false" style="position:absolute;left:${left}px;top:634px;width:172px;height:170px">${text}<svg viewBox="${vb}" width="41" height="28"><path d="${d}" fill="currentColor"/></svg></div>`;
const iconBtn = (src, left, disabled, id) => `<button ${id ? 'id="' + id + '"' : ''} ${disabled ? 'disabled' : ''} style="position:absolute;left:${left}px;top:798px;width:39px;height:48px"><img src="https://cdn.example/${src}"></button>`;

function judgePage() {
  return `<div id="prompt">Les acteurs improvisent souvent.</div><div id="q">${card('1', '0 0 41 28', CHECK_D, 453)}${card('2', '0 0 36 38', CROSS_D, 641)}${iconBtn('04f2.svg', 550, false)}${iconBtn('a276.svg', 613, false)}${iconBtn('1197.svg', 676, true, 'check')}</div>`;
}

// 点卡片后置 aria-checked 并解锁检查键；点检查键后进入下一题（换一组卡）
const JUDGE_JS = `
const cards = [...document.querySelectorAll('[data-test="challenge-choice"]')];
cards.forEach((c) => c.addEventListener('click', () => { c.setAttribute('aria-checked','true'); const b = document.getElementById('check'); if (b) b.disabled = false; }));
const ck = document.getElementById('check');
if (ck) ck.addEventListener('click', () => {
  if (ck.disabled) return;
  const q = document.getElementById('q');
  q.innerHTML = '<div id="q2">NEXT QUESTION</div>' + ${JSON.stringify('<div data-test="challenge-choice" role="radio" aria-checked="false" style="position:absolute;left:453px;top:634px;width:172px;height:170px">alpha<svg viewBox="0 0 41 28"><path d="' + CHECK_D + '"/></svg></div><div data-test="challenge-choice" role="radio" aria-checked="false" style="position:absolute;left:641px;top:634px;width:172px;height:170px">beta<svg viewBox="0 0 36 38"><path d="' + CROSS_D + '"/></svg></div><button id="check2" disabled style="position:absolute;left:676px;top:798px;width:39px;height:48px"><img src="https://cdn.example/1197.svg"></button>')};
  window.advanced = (window.advanced || 0) + 1;
});`;

async function main() {
  const radioQuiz = require('./radio-quiz.js');
  let pass = 0, fail = 0;
  const t = async (name, fn) => {
    try { await fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + ' -> ' + e.message); }
  };

  console.log('radio-quiz');
  // 形状分类：勾左右不对称、叉四角都有墨且对称
  await t('classifyShape：勾/叉/未知', async () => {
    assert.equal(radioQuiz.classifyShape({ mirrorLR: 0.62, mirrorUD: 0.35, ink: 0.12, corners: { tl: 0.01, tr: 0.4, bl: 0.2, br: 0.3 } }), 'check');
    assert.equal(radioQuiz.classifyShape({ mirrorLR: 0.05, mirrorUD: 0.04, ink: 0.15, corners: { tl: 0.3, tr: 0.3, bl: 0.3, br: 0.3 } }), 'cross');
    assert.equal(radioQuiz.classifyShape({ mirrorLR: 0.22, mirrorUD: 0.22, ink: 0.1, corners: { tl: 0.2, tr: 0.2, bl: 0.2, br: 0.2 } }), 'unknown');
    // 真机实测指标回归（2026-11-19 s3u71l5 判断题）：勾 tl=0/tr=0.603，叉四角 0.46~0.66、ud=0.253
    assert.equal(radioQuiz.classifyShape({ mirrorLR: 0.514, mirrorUD: 0.477, ink: 0.342, corners: { tl: 0, tr: 0.603, bl: 0.222, br: 0 } }), 'check');
    assert.equal(radioQuiz.classifyShape({ mirrorLR: 0.074, mirrorUD: 0.253, ink: 0.451, corners: { tl: 0.662, tr: 0.629, bl: 0.486, br: 0.457 } }), 'cross');
    assert.equal(radioQuiz.classifyShape(null), 'unknown');
    assert.equal(radioQuiz.classifyShape({ err: 'x' }), 'unknown');
  });

  await t('pickJudgeElement：prompt 唯一才用，多个/没有都拒绝', async () => {
    const s = { elements: [{ type: 'challenge', prompt: 'Les acteurs improvisent souvent.', isTrue: false }, { type: 'challenge', prompt: 'Autre phrase.', isTrue: true }] };
    assert.equal(radioQuiz.pickJudgeElement(s, 'LES VOYAGES DE BÉA Les acteurs improvisent souvent. 1 2').el.isTrue, false);
    assert.equal(radioQuiz.pickJudgeElement({ elements: s.elements }, 'Autre phrase.').el.isTrue, true);
    assert.match(radioQuiz.pickJudgeElement({ elements: [] }, 'x').error, /UNMATCHED/);
    assert.match(radioQuiz.pickJudgeElement({ elements: [{ prompt: 'a', isTrue: true }, { prompt: 'a b', isTrue: false }] }, 'a b c').error, /UNMATCHED/);
  });

  await t('pickChoiceElement：卡片文本唯一匹配元素，多元素拒绝', async () => {
    const s = { elements: [{ type: 'challenge', prompt: 'p1', choices: ['一', '二', '三'], correctIndex: 0 }, { type: 'challenge', prompt: 'p2', choices: ['四', '五', '六'], correctIndex: 1 }] };
    assert.equal(radioQuiz.pickChoiceElement(s, ['一', '二', '三']).el.prompt, 'p1');
    assert.match(radioQuiz.pickChoiceElement(s, ['一', '七', '八']).error, /UNMATCHED/);
  });

  await t('mapCards：卡片↔choices 唯一映射，重复文本拒绝', async () => {
    const ok = radioQuiz.mapCards([{ text: '4 喝' }, { text: '5 茶' }], ['茶', '喝']);
    assert.deepEqual(ok.map, [{ card: 0, choice: 1 }, { card: 1, choice: 0 }]);
    assert.match(radioQuiz.mapCards([{ text: '喝' }, { text: '喝' }], ['喝', '茶']).error, /AMBIGUOUS|DUP/);
  });

  await t('correctIndices：数组/单值/缺失', async () => {
    assert.deepEqual(radioQuiz.correctIndices({ correctIndices: [1, 3] }), [1, 3]);
    assert.deepEqual(radioQuiz.correctIndices({ correctIndex: 2 }), [2]);
    assert.equal(radioQuiz.correctIndices({}), null);
  });

  // 与 auto-runner.js 一致：本机 Playwright 自带 Chrome for Testing 有启动问题，优先用系统 Chrome
  const sysChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser = await chromium.launch({ headless: true, executablePath: require('node:fs').existsSync(sysChrome) ? sysChrome : undefined });
  try {
    await t('判断题：isTrue=false 点叉、点检查、进入下一题', async () => {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.setContent('<div id="qbox">' + judgePage() + '</div><script>' + JUDGE_JS + '</script>');
      const session = { elements: [{ type: 'challenge', prompt: 'Les acteurs improvisent souvent.', isTrue: false }] };
      const r = await radioQuiz.run(page, session, async () => {});
      assert.equal(r.status, 'blocked', '本地页面到第二题就走不动（第二题没接检查逻辑），但第一题必须已提交');
      assert.equal(await page.evaluate(() => window.advanced), 1);
      const second = await page.evaluate(() => [...document.querySelectorAll('[data-test="challenge-choice"]')].map((e) => e.getAttribute('aria-checked')));
      assert.deepEqual(second, ['false', 'false']);
      await page.close();
    });

    await t('判断题：形状判不出 → 零点击、blocked', async () => {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1280, height: 900 });
      const circle = 'M20 4a16 16 0 1 0 0 32 16 16 0 0 0 0-32z';
      const html = `<div id="q">${card('1', '0 0 41 28', circle, 453)}${card('2', '0 0 36 38', circle, 641)}${iconBtn('1197.svg', 676, true, 'check')}</div>`;
      await page.setContent(html);
      const session = { elements: [{ type: 'challenge', prompt: 'Les acteurs improvisent souvent.', isTrue: true }] };
      const r = await radioQuiz.run(page, session, async () => {});
      assert.equal(r.status, 'blocked');
      assert.match(r.error, /RADIO_JUDGE_SHAPE_UNRESOLVED|RADIO_CHOICE_UNMATCHED/);
      assert.equal(await page.evaluate(() => document.querySelectorAll('[aria-checked="true"]').length), 0);
      await page.close();
    });

    await t('选择题：correctIndex 唯一匹配卡片并提交', async () => {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1280, height: 900 });
      const html = `<div id="q">
        ${card('一', '0 0 41 28', CHECK_D, 300)}${card('二', '0 0 41 28', CHECK_D, 500)}${card('三', '0 0 41 28', CHECK_D, 700)}
        ${iconBtn('1197.svg', 676, true, 'check')}
      </div>
      <script>
        const cards = [...document.querySelectorAll('[data-test="challenge-choice"]')];
        cards.forEach((c) => c.addEventListener('click', () => { c.setAttribute('aria-checked','true'); const b = document.getElementById('check'); if (b) b.disabled = false; }));
        const CHECK_D = ${JSON.stringify(CHECK_D)}, CROSS_D = ${JSON.stringify(CROSS_D)};
        document.getElementById('check').addEventListener('click', () => { window.advanced = 1; document.getElementById('q').innerHTML = '<div>NEXT</div>' + NEXT2(); });
        function NEXT2() { return '<div data-test="challenge-choice" role="radio" aria-checked="false" style="position:absolute;left:453px;top:634px;width:172px;height:170px">下一题A<svg viewBox="0 0 41 28"><path d="' + CHECK_D + '"/></svg></div><div data-test="challenge-choice" role="radio" aria-checked="false" style="position:absolute;left:641px;top:634px;width:172px;height:170px">下一题B<svg viewBox="0 0 36 38"><path d="' + CROSS_D + '"/></svg></div>'; }
      </script>`;
      await page.setContent(html);
      const session = { elements: [{ type: 'challenge', prompt: 'p', choices: ['一', '二', '三'], correctIndex: 1 }] };
      const r = await radioQuiz.run(page, session, async () => {});
      assert.equal(await page.evaluate(() => window.advanced), 1);
      assert.equal(await page.evaluate(() => document.querySelectorAll('[aria-checked="true"]').length), 0, '换页后旧卡已移除');
      assert.ok(['done', 'blocked'].includes(r.status));
      await page.close();
    });

    await t('提交键没解锁 → RADIO_CHECK_UNRESOLVED、不点检查', async () => {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1280, height: 900 });
      const html = `<div>Les acteurs improvisent souvent.</div><div id="q">${card('1', '0 0 41 28', CHECK_D, 453)}${card('2', '0 0 36 38', CROSS_D, 641)}${iconBtn('1197.svg', 676, true, 'check')}</div>
        <script>document.querySelectorAll('[data-test="challenge-choice"]').forEach((c) => c.addEventListener('click', () => c.setAttribute('aria-checked','true')));</script>`;
      await page.setContent(html);
      const session = { elements: [{ type: 'challenge', prompt: 'p', isTrue: true }] };
      const r = await radioQuiz.run(page, session, async () => {});
      assert.equal(r.status, 'blocked');
      assert.match(r.error, /RADIO_CHECK_UNRESOLVED/);
      assert.ok(!(await page.evaluate(() => window.advanced)));
      await page.close();
    });

    await t('点卡无选中反馈 → RADIO_JUDGE_SELECT_NO_FEEDBACK、不提交', async () => {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1280, height: 900 });
      const html = `<div>Les acteurs improvisent souvent.</div><div id="q">${card('1', '0 0 41 28', CHECK_D, 453)}${card('2', '0 0 36 38', CROSS_D, 641)}${iconBtn('1197.svg', 676, true, 'check')}</div>`;
      await page.setContent(html);
      const session = { elements: [{ type: 'challenge', prompt: 'Les acteurs improvisent souvent.', isTrue: false }] };
      const r = await radioQuiz.run(page, session, async () => {});
      assert.equal(r.status, 'blocked');
      assert.match(r.error, /RADIO_JUDGE_SELECT_NO_FEEDBACK/);
      await page.close();
    });
  } finally {
    await browser.close();
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
