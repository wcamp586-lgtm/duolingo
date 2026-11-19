// 电台专用「选择配对」：只处理已确认的电台页面。
// 页面事实（真机样本）：左侧编号按钮与右侧中文按钮共用词键，例如两侧都是
// data-test="演出-challenge-tap-token"；本样本每词左右各一个。
// 规则：同词键必须恰好两个、分列左右，才点左→点右；每对必须看到失活/消失反馈，
// 否则停止；不按顺序猜、不混点其他按钮、不在失活状态重复点。
function norm(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

async function readButtons(page) {
  return await page.evaluate(() => {
    const vis = (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const norm = (x) => (x || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('button[data-test*="challenge-tap-token"]')]
      .filter(vis)
      .map((e) => {
        const r = e.getBoundingClientRect();
        const test = e.getAttribute('data-test') || '';
        return {
          test,
          key: test.replace(/-challenge-tap-token$/, ''),
          text: norm(e.innerText).slice(0, 40),
          enabled: !(e.disabled || e.getAttribute('aria-disabled') === 'true'),
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      });
  }).catch(() => null);
}

// 等页面真正渲染出「选择配对」（真机约 22 秒），不用过短的固定等待。
async function waitPairing(page, tries = 35) {
  for (let i = 0; i < tries; i++) {
    const text = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
    if (text.includes('选择配对')) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function waitFeedback(page, pair) {
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1000);
    const now = await readButtons(page);
    if (!now) continue;
    const left = now.find((b) => b.key === pair.key && Math.abs(b.x - pair.left.x) < 40 && Math.abs(b.y - pair.left.y) < 40);
    const right = now.find((b) => b.key === pair.key && Math.abs(b.x - pair.right.x) < 40 && Math.abs(b.y - pair.right.y) < 40);
    const gone = !left || !right;
    const disabled = left && right && !left.enabled && !right.enabled;
    if (gone || disabled) return true;
  }
  return false;
}

async function run(page, check) {
  if (!(await waitPairing(page))) return { status: 'not-match' };
  const buttons = await readButtons(page);
  if (!buttons || !buttons.length) return { status: 'not-match' };
  const groups = new Map();
  for (const b of buttons) {
    if (!b.enabled) continue;
    if (!groups.has(b.key)) groups.set(b.key, []);
    groups.get(b.key).push(b);
  }
  const pairs = [];
  for (const [key, arr] of groups) {
    if (arr.length !== 2) {
      return { status: 'blocked', error: 'RADIO_TAP_AMBIGUOUS key=' + key + ' count=' + arr.length };
    }
    const [left, right] = arr.sort((a, b) => a.x - b.x);
    if (Math.abs(left.x - right.x) < 100) {
      return { status: 'blocked', error: 'RADIO_TAP_AMBIGUOUS key=' + key + ' same-column' };
    }
    pairs.push({ key, left, right });
  }
  if (!pairs.length) return { status: 'not-match' };
  console.log('RADIO_TAP_PAIRS ' + pairs.length + ' keys=' + JSON.stringify(pairs.map((p) => [p.key, p.left.text, p.right.text])));
  for (const pair of pairs) {
    await check();
    console.log('RADIO_TAP_CLICK key=' + pair.key);
    await page.mouse.click(pair.left.x + pair.left.w / 2, pair.left.y + pair.left.h / 2);
    await page.waitForTimeout(400);
    await check();
    await page.mouse.click(pair.right.x + pair.right.w / 2, pair.right.y + pair.right.h / 2);
    const feedback = await waitFeedback(page, pair);
    console.log('RADIO_TAP_FEEDBACK key=' + pair.key + ' ok=' + feedback);
    if (!feedback) {
      return { status: 'blocked', error: 'RADIO_TAP_NO_FEEDBACK key=' + pair.key };
    }
  }
  // 配对只是一组题：留在这页等下一题真正出现，不自动回 /learn、不重进
  const before = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim()).catch(() => '');
  let nextText = before;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    const t = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim()).catch(() => '');
    nextText = t;
    if (t && t !== before) break;
  }
  const next = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const norm = (x) => (x || '').replace(/\s+/g, ' ').trim();
    const kidsOf = (e) => [...e.querySelectorAll('*')].slice(0, 8).map((k) => ({
      tag: k.tagName.toLowerCase(),
      attrs: [...k.attributes].map((a) => a.name).slice(0, 8),
      cls: norm(k.getAttribute('class') || '').split(' ').filter(Boolean).slice(0, 5),
    }));
    const items = [...document.querySelectorAll('button, [role="button"]')].filter(vis).slice(0, 30).map((e, i) => {
      const r = e.getBoundingClientRect();
      const svg = e.querySelector('svg');
      return {
        i,
        test: e.getAttribute('data-test') || '',
        aria: e.getAttribute('aria-label') || '',
        title: e.getAttribute('title') || '',
        role: e.getAttribute('role') || '',
        class: norm(e.getAttribute('class') || '').split(' ').filter(Boolean).slice(0, 8),
        text: norm(e.innerText).slice(0, 60),
        disabled: !!(e.disabled || e.getAttribute('aria-disabled') === 'true'),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        kids: kidsOf(e),
        svg: svg ? { hasPath: !!svg.querySelector('path'), pathCount: svg.querySelectorAll('path').length } : null,
        parentText: norm(e.parentElement ? e.parentElement.innerText : '').slice(0, 80),
      };
    });
    return { url: location.pathname, text: norm(document.body.innerText).slice(0, 300), buttons: items, media: document.querySelectorAll('audio, video').length };
  }).catch(() => null);
  console.log('RADIO_TAP_NEXT ' + JSON.stringify(next));
  return { status: 'partial', next };
}

module.exports = { run, readButtons, waitPairing };
