// 普通课执行器：一步 = 读 DOM → 认题 → 作答 → 点检查/继续。
//
// 页面读取 / 点击 / 填框已抽到 lesson-dom.js，与 hint.js 共用；这里保留普通课的
// 一步流程（认题、作答、推进）和自动模式自己的日志。
const core = require('./core.js');
const { skipKind } = require('./automation-policy.js');
const { readDom, readDomOnce, clickMarks, fillInput } = require('./lesson-dom.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 题目指纹：题型 + 题干 + 选项集合。只有它变了，才算「换了一题」
function challengeSig(dom) {
  if (!dom) return '';
  // 只用题目身份（题型 + 问句 + 选项）：输入区内容和按钮文字变化不代表换题
  const prompt = dom.promptText != null ? dom.promptText : dom.boxText;
  return [dom.type || '', String(prompt || '').slice(0, 300), (dom.options || []).join('\u0001')].join('\u0002');
}

// 提交后的定性：先认「反馈出现」（按钮变成继续），再认「题目真的变了」，都没有就是没进展。
// 单纯 DOM 还在不算进展——2026-11-20 s2u42l7 的 name 题就是被这条无限当成功。
function classifySubmit(before, after, footerLabel) {
  if (!after) return 'left';
  if (footerLabel && /继续/.test(footerLabel)) return 'feedback';
  if (challengeSig(before) !== challengeSig(after)) return 'changed';
  return 'same';
}

// 同一题连续无进展的独立保护：签名不变超过 limit 毫秒就该停
function sameTickState(sig, state, now, limit = 30000) {
  const prev = state && state.sig === sig ? state.since : now;
  return { sig, since: prev, abort: now - prev > limit };
}

// 点检查/继续推进；连续点两次（第一次是提交、第二次是下一题）。
// 不再无条件吞点击错误：返回 { clicked, errors, ready }，上层据此判断是否有真实推进。
async function advance(page, check = async () => {}) {
  let clicked = 0;
  let ready = 0;
  const errors = [];
  for (let k = 0; k < 2; k++) {
    await check();
    const footer = page.locator('[data-test="player-next"]:visible');
    const next = k === 0 ? footer : footer.filter({ hasText: /^\s*继续\s*$/ });
    if (await next.count() !== 1) break;
    // 等按钮真正可点，而不是固定 sleep 一大截：快很多，也不会在动画中途点空
    const canClick = await page.waitForFunction(() => {
      const b = document.querySelector('[data-test="player-next"]');
      return !!b && !b.disabled && b.getBoundingClientRect().width > 0;
    }, null, { timeout: 4000 }).then(() => true).catch(() => false);
    if (!canClick) { errors.push('footer-not-ready'); break; }
    ready++;
    try {
      await next.click({ timeout: 3000 });
      clicked++;
    } catch (e) {
      errors.push(String((e && e.message) || e).slice(0, 80));
    }
    await sleep(k === 0 ? 400 : 250);
  }
  return { clicked, errors, ready };
}

// 提交后的核验：反馈出现（按钮变继续）/ 换题 / 已离开课程 才算 answered；
// 否则返回 nochange（带点击诊断），由主循环的同题 30 秒保护决定停不停。
async function afterSubmit(page, before, extra = {}) {
  let after = null;
  let readErr = null;
  try {
    after = await readDomOnce(page);
  } catch (e) {
    readErr = String((e && e.message) || e).slice(0, 100);
  }
  const url = typeof page.url === 'function' ? page.url() : '';
  const leftRoute = !!url && !/\/lesson(?:\/|$)/.test(new URL(url).pathname || '');
  let footerLabel = '';
  try {
    const footer = page.locator('[data-test="player-next"]:visible');
    if (await footer.count() === 1) footerLabel = String(await footer.innerText()).trim();
  } catch {}
  // 读取失败 ≠ 已离开：只有真实路由离开才算进展，其它归 unknown 交回主循环
  if (readErr) {
    if (leftRoute) return { status: 'answered', evidence: 'left', url, readErr, ...extra };
    return { status: 'unknownRead', readErr, url, footerLabel, ...extra };
  }
  // 「继续页空点」不算进展：点之前就已经是「继续」的同一页，必须看到题目/路由真变化
  const stuckContinue = !!(extra.continued && /继续/.test(footerLabel) && /继续/.test(extra.beforeFooter || ''));
  if (after) {
    if (/继续/.test(footerLabel) && !stuckContinue) return { status: 'answered', evidence: 'feedback', ...extra };
    if (challengeSig(before) !== challengeSig(after)) return { status: 'answered', evidence: 'changed', ...extra };
    return { status: 'nochange', dom: after, footerLabel, click: extra.click, ...extra };
  }
  // 没有题目容器：只有真实路由离开 / 结算控件 / 反馈继续才算进展
  if (leftRoute) return { status: 'answered', evidence: 'left', url, ...extra };
  try {
    const end = await page.locator('[data-test="legendary-session-end-continue"]:visible').count();
    if (end) return { status: 'answered', evidence: 'settled', url, ...extra };
  } catch {}
  if (/继续/.test(footerLabel)) return { status: 'answered', evidence: 'feedback', url, ...extra };
  return { status: 'waiting', url, footerLabel, ...extra };
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
      const before = { type: dom.type, boxText: dom.boxText, promptText: dom.promptText, options: dom.options };
      let clicked = 0;
      const errors = [];
      try { await footer.click({ timeout: 3000 }); clicked++; }
      catch (e) { errors.push(String((e && e.message) || e).slice(0, 80)); }
      // 点了不等于推进：继续页若原样不动，返回 nochange 交给同题 30 秒保护
      return await afterSubmit(page, before, { click: { clicked, errors, ready: 1 }, continued: true, beforeFooter: label });
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
    const adv = await advance(page, check);
    return await afterSubmit(page, dom, { type: ch.type, answer: ans, click: adv });
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
  if (n !== marks.length) return { status: 'clickfail', dom, chType: ch.type, click: { clicked: n, expected: marks.length } };
  const adv = await advance(page, check);
  return await afterSubmit(page, dom, { type: ch.type, n, plan: plan.length, mapped: marks.length, click: adv });
}

module.exports = { step, readDom, fillInput, advance, challengeSig, classifySubmit, sameTickState, afterSubmit };
