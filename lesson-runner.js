// 普通课执行器：一步 = 读 DOM → 认题 → 作答 → 点检查/继续。
//
// 这套逻辑来自 hint.js（半自动模式已经稳定跑过很多节），这里抽出来给调度器用。
// 暂时是复制而不是共享，因为 hint.js 改动会影响你现在用的半自动模式；
// 等自动跑稳定后再合并成一份。
const core = require('./core.js');
const { skipKind } = require('./automation-policy.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COLLECT_SRC = `(() => {
  const box = document.querySelector('[data-test*="challenge challenge-"]');
  if (!box) return null;
  const vis = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.bottom <= 0 || r.top >= innerHeight) return false;
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (parseFloat(s.opacity || '1') <= 0.1) return false;
    return true;
  };
  const dedupe = (ls) => {
    const seen = new Set();
    const out = [];
    for (const e of ls) {
      if (!(e.textContent || '').trim()) continue;
      const r = e.getBoundingClientRect();
      const k = Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.width) + ',' + Math.round(r.height);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
    return out;
  };
  const skip = /^(检查|继续|跳过|退出|开始|现在不做口语题|使用键盘|加大难度)$/;
  const isToken = (e) => /challenge-(tap-token|choice)/.test(e.getAttribute('data-test') || '');
  const all = [
    ...box.querySelectorAll('[data-test$="challenge-tap-token"]'),
    ...box.querySelectorAll('[data-test*="challenge-choice"]'),
    ...box.querySelectorAll('button'),
  ];
  const els = dedupe(all.filter(vis).filter((e) => isToken(e) || !skip.test((e.textContent || '').trim())));
  return els;
})()`;

async function readDom(page) {
  return await page.evaluate((src) => {
    const box = document.querySelector('[data-test*="challenge challenge-"]');
    if (!box) return null;
    const els = eval(src);
    const type = (box.getAttribute('data-test') || '').replace('challenge challenge-', '');
    const clean = (s) => (s || '').trim().replace(/^\d+\s*/, '');
    const hasInput = [...box.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')]
      // 缺词填空的空位空闲时宽度是 0，只看宽度会漏掉；contenteditable 本身可编辑就算
      .some((e) => e.getBoundingClientRect().width > 0 || e.isContentEditable);
    return { type, options: els.map((e) => clean(e.textContent)), hasInput, boxText: (box.innerText || '') };
  }, COLLECT_SRC).catch(() => null);
}

async function clickMarks(page, marks) {
  return await page.evaluate(({ src, list }) => {
    const els = eval(src);
    if (!els) return 0;
    let n = 0;
    for (const m of list) {
      const el = els[m.index];
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      el.click(); n++;
    }
    return n;
  }, { src: COLLECT_SRC, list: marks }).catch(() => 0);
}

async function fillInput(page, text) {
  const box = page.locator('[data-test*="challenge challenge-"]');
  const el = box.locator('textarea, input[type="text"], [contenteditable="true"]').first();
  if (!(await el.count().catch(() => 0))) return false;
  const handle = await el.elementHandle().catch(() => null);
  if (!handle) return false;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const read = async () => norm(await handle.evaluate((e) => (e.value != null ? e.value : (e.textContent || ''))).catch(() => ''));
  const want = norm(text);
  const clear = async () => {
    await handle.click({ timeout: 1500, force: true }).catch(() => handle.focus().catch(() => {}));
    await page.keyboard.press('Meta+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
  };
  try {
    await handle.scrollIntoViewIfNeeded().catch(() => {});
    await clear();
    await handle.type(text, { delay: 12 });
    await sleep(200);
    let got = await read();
    if (got === want) return true;
    await clear();
    await page.keyboard.insertText(text).catch(() => {});
    await sleep(200);
    got = await read();
    if (got === want) return true;
    if (want && got.includes(want)) return true;
    return false;
  } catch (e) {
    return false;
  }
}

// 点检查/继续推进；连续点两次（第一次是提交、第二次是下一题）
async function advance(page, check = async () => {}) {
  for (let k = 0; k < 2; k++) {
    await check();
    const footer = page.locator('[data-test="player-next"]:visible');
    const next = k === 0 ? footer : footer.filter({ hasText: /^\s*继续\s*$/ });
    if (await next.count() !== 1) break;
    // 等按钮真正可点，而不是固定 sleep 一大截：快很多，也不会在动画中途点空
    const ready = await page.waitForFunction(() => {
      const b = document.querySelector('[data-test="player-next"]');
      return !!b && !b.disabled && b.getBoundingClientRect().width > 0;
    }, null, { timeout: 4000 }).then(() => true).catch(() => false);
    if (!ready) break;
    await next.click({ timeout: 3000 }).catch(() => {});
    await sleep(k === 0 ? 400 : 250);
  }
}

async function step(page, session, check = async () => {}, lexemes = null) {
  await check();
  const dom = await readDom(page);
  if (!dom) {
    // 没有题目容器：可能是过场页、完成页，或者刚提交完
    return { status: 'outside' };
  }
  // 听力/口语不在自动作答范围：点平台的跳过入口，跳过这题继续往下走
  if (skipKind(dom.type)) {
    const sk = page.locator('[data-test="player-skip"]:visible');
    if (await sk.count() === 1 && await sk.isEnabled()) {
      await check();
      await sk.click({ timeout: 3000 });
      await sleep(600);
    }
    // 关闭听说后，原题仍显示。平台在反馈栏提供「继续」。
    const next = page.locator('[data-test="player-next"]:visible')
      .filter({ hasText: /^\s*继续\s*$/ });
    if (await next.count() === 1 && await next.isEnabled()) {
      await check();
      await next.click({ timeout: 3000 });
      return { status: 'skipped', type: dom.type };
    }
    const after = await readDom(page);
    if (!after || after.type !== dom.type || after.boxText !== dom.boxText) {
      return { status: 'skipped', type: dom.type };
    }
    return { status: 'nomatch', kind: 'speak-no-skip', dom };
  }

  const footer = page.locator('[data-test="player-next"]:visible');
  if (await footer.count() === 1) {
    const label = (await footer.innerText()).trim();
    if (/^[.…]*$/.test(label) || await footer.getAttribute('aria-busy') === 'true') {
      return { status: 'waiting' };
    }
    if (label === '继续') {
      if (!await footer.isEnabled()) return { status: 'waiting' };
      await check();
      await footer.click({ timeout: 3000 });
      return { status: 'advanced' };
    }
  }

  const pools = core.collectChallenges(session);

  if (dom.hasInput) {
    let ch = core.matchByPrompt(pools, dom.boxText, dom.type);
    // name 题偶尔题型标注和池子不一致；它答案唯一性强，允许回退到不限题型
    if (!ch && dom.type === 'name') ch = core.matchByPrompt(pools, dom.boxText);
    if (!ch) ch = core.matchByDisplay(pools, dom.boxText, dom.type);
    if (!ch) return { status: 'nomatch', kind: 'input', dom };
    const ans = core.textAnswers(ch)[0];
    if (!ans) return { status: 'nomatch', kind: 'input-empty', dom };
    await check();
    const ok = await fillInput(page, ans);
    if (!ok) return { status: 'fillfail', dom, ans };
    await advance(page, check);
    return { status: 'answered', type: ch.type, answer: ans };
  }

  let ch = core.resolveChallenge(pools, dom);
  // 配对题失配时用拦截到的 practice-lexemes 词表重建（hint 模式一直有，自动模式补齐）
  if (!ch && core.normType(dom.type) === 'match' && Array.isArray(lexemes) && lexemes.length) {
    ch = core.challengeFromLexemes(lexemes, dom.options);
  }
  if (!ch && /^(tapComplete|completeReverseTranslation|partialReverseTranslate)$/.test(dom.type)) {
    ch = core.matchByDisplay(pools, dom.boxText, dom.type);
  }
  if (!ch) {
    // 选项集相同但答案不同的题（普通课"新单词"：同一个词表问"哪个是咖啡/茶"）靠题干消歧
    const hits = pools.filter((p) => core.normType(p.type) === core.normType(dom.type) && p.prompt && dom.boxText.includes(p.prompt));
    if (hits.length === 1) ch = hits[0];
  }
  if (!ch) return { status: 'nomatch', kind: 'choice', dom };

  const plan = core.buildPlan(ch);
  const marks = core.assignMarks(dom.options, plan);
  if (!marks.length || marks.length !== plan.length) return { status: 'nomatch', kind: 'plan-incomplete', dom };
  await check();
  const n = await clickMarks(page, marks);
  if (n !== marks.length) return { status: 'clickfail', dom, chType: ch.type };
  await advance(page, check);
  return { status: 'answered', type: ch.type, n, plan: plan.length, mapped: marks.length };
}

module.exports = { step, readDom, fillInput, advance };
