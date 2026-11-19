// 普通课执行器：一步 = 读 DOM → 认题 → 作答 → 点检查/继续。
//
// 页面读取 / 点击 / 填框已抽到 lesson-dom.js，与 hint.js 共用；这里保留普通课的
// 一步流程（认题、作答、推进）和自动模式自己的日志。
const core = require('./core.js');
const { skipKind } = require('./automation-policy.js');
const { readDom, clickMarks, fillInput } = require('./lesson-dom.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // 新词形·选词填空：页面显示 patternSentences 模板句，靠它匹配，答案仍是 choices[correctIndex]
  if (!ch && core.normType(dom.type) === 'patternTapComplete') {
    ch = core.matchByPattern(pools, dom.boxText, dom.type);
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
