const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const policy = require('./automation-policy.js');
const core = require('./core.js');
const storyRunner = require('./story-runner.js');
const lessonRunner = require('./lesson-runner.js');
const lessonGuard = require('./lesson-guard.js');
const radioTap = require('./radio-tap.js');
const radioQuiz = require('./radio-quiz.js');
const { prepareByUrl, prepareByNode, findCourseLevel, LEARN, ORIGIN } = require('./legendary-entry.js');

const nextSelector = '[data-test="player-next"]:visible';
// 配对题兜底用的词表（practice-lexemes 响应），solve 和响应回调都要读
let lexemes = null;
// 页面预加载的 session 先到、目标节点后设，按 skillId|levelIndex 缓存，进课时直接复用
const sessionCache = new Map();

function numberArg(name, minimum) {
  const index = process.argv.indexOf('--' + name);
  if (index === -1) return undefined;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < minimum) throw new Error('无效参数 --' + name);
  if (name !== 'minutes' && !Number.isInteger(value)) throw new Error('--' + name + ' 需要整数');
  return value;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 页面签名只用于判断“点击后有没有真的换屏”，不参与认题。
const screenSig = (snapshot) => snapshot
  ? lessonGuard.classifyPage(snapshot) + '|' + snapshot.url + '|' + (snapshot.text || '').slice(0, 80)
  : 'null';

// 点按钮：React 会在点击瞬间重渲染，locator.click 常报 "element was detached"。
// 退一步用真实鼠标坐标点，并允许重试。
async function clickSafe(page, loc, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const el = loc.first();
      if (!(await el.count().catch(() => 0))) return false;
      if (!(await el.isVisible().catch(() => false))) { await wait(400); continue; }
      const box = await el.boundingBox().catch(() => null);
      if (box && box.width > 5 && box.height > 5) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return true;
      }
      await el.click({ timeout: 3000 });
      return true;
    } catch (e) { await wait(500); }
  }
  return false;
}

async function solve(page, target, check) {
  let answered = 0;
  let skippedCount = 0;
  let stalled = 0;
  // 同一道题（题目指纹不变）的独立停滞计时，和全局 stalled 分开
  let sameTick = null;
  let feedbackSince = null;
  let nodom = 0;
  let nomatchLogged = false;
  const progress = lessonGuard.createProgressGuard();
  // 电台专用：只有已确认的 radio-direct 入口才走配对分支，其他类型/入口不套
  if (target.slot.type === 'duo_radio' && target.radioDirect) {
    await check();
    const tap = await radioTap.run(page, check);
    if (tap.status === 'blocked') throw new Error(tap.error);
    if (tap.status === 'not-match') throw new Error('RADIO_TAP_NOT_MATCH 页面没有出现「选择配对」');
    // 配对完成即「一组题通过」：留在同一页面继续判断题/单选/多选，不回 /learn、不重进
    const quiz = await radioQuiz.run(page, target.data, check);
    if (quiz.status === 'blocked') throw new Error('RADIO_QUIZ_BLOCKED ' + quiz.error);
    return answered + (quiz.answered || 0);
  }
  let sawData = !!target.data;
  let screenSeen = '';
  let coverClicked = false;
  let splashClicked = false;
  let storyDone = false;
  for (let round = 0; round < 400; round++) {
    await check();
    if (LEARN.test(page.url())) return answered;
    if (!sawData && target.data) { sawData = true; progress.touch(); }
    // 普通练习/单元复习的引导屏：点「开始练习」后 session 才请求（unit 73 l6 practice 实测），
    // 先于 45/90 秒超时检查处理，每个节点只点一次。
    if (target.mode === 'normal' && !splashClicked && target.slot.type !== 'story' && target.slot.type !== 'duo_radio') {
      const splash = page.locator('[data-test="session-splash-title"]:visible');
      const splashNext = page.locator('[data-test="player-next"]:visible');
      const hasSplash = (await splash.count()) > 0;
      const hasNext = (await splashNext.count()) > 0;
      if (policy.shouldClickSplash({ mode: 'normal', type: target.slot.type, hasData: !!target.data, alreadyClicked: splashClicked, hasSplashTitle: hasSplash, hasPlayerNext: hasNext })) {
        splashClicked = true;
        await check();
        await clickSafe(page, splashNext.first());
        progress.touch();
        await page.waitForTimeout(1500);
      }
    }
    // 没收到匹配的 session 时不要一直空转：页面已在题目页说明课已开、只是 session 晚到，
    // 给 150 秒（unit 73 l10 实测 session 在 90 秒后才到）；还没到题目页则 45 秒就报，并带上页面状态。
    if (!target.data && target.startedAt) {
      const snapshot = await lessonGuard.readPageState(page).catch(() => null);
      const inQuestion = snapshot && lessonGuard.classifyPage(snapshot) === 'question';
      if (Date.now() - target.startedAt > (inQuestion ? 150000 : 45000)) {
        throw new Error('未收到与目标节点匹配的课程数据；页面：' + lessonGuard.describePage(snapshot));
      }
    }

    // 题数只是答题进度，不是整课退出依据（有替换池/自适应/跳过时更不可靠）：
    // 必须等真实完成信号（LESSON_END / 回 /learn）才交回主循环对账，否则会读到 XP=0。

    if (target.slot.type === 'story') {
      const finish = page.locator('[data-test="stories-player-done"]:visible');
      const cover = page.locator('[data-test="story-start"]:visible');
      // 新版故事封面（2026-11-20 unit 73 取证）：/lesson 里的 stories-element 封面只有
      // stories-player-continue「继续」，没有 story-start；不点它就不会发 stories API，形成死锁。
      const storyContinue = page.locator('[data-test="stories-player-continue"]:visible');
      const storyElements = page.locator('[data-test="stories-element"]:visible');
      if (await finish.count()) {
        await check();
        await clickSafe(page, finish);
        progress.touch();
        await page.waitForURL(LEARN, { timeout: 45000 });
        return answered;
      }
      const coverAction = policy.storyCoverAction({
        hasStoryStart: (await cover.count()) > 0,
        hasContinue: (await storyContinue.count()) > 0,
        hasElements: (await storyElements.count()) > 0,
        hasData: !!target.data,
        alreadyCoverClicked: coverClicked,
      });
      if (coverAction) {
        // 封面必须先点（旧 UI「开始读故事」/新 UI「继续」）才会请求故事数据；
        // 原来只人 story-start，导致新 UI 永远等不到数据。每个节点只点一次。
        coverClicked = true;
        await check();
        await clickSafe(page, coverAction === 'start' ? cover : storyContinue.first());
        progress.touch();
        await page.waitForTimeout(2000);
        // 点完只等数据/页面变化，数据超时仍由循环开头 45 秒兜底，不无限重试
      } else if (target.data) {
        const result = await storyRunner.step(page, target.data, check);
        if (result.status === 'blocked') throw new Error(result.error);
        if (result.status === 'answered') answered++;
        if (result.status === 'done') storyDone = true;
        if (['answered', 'next'].includes(result.status)) progress.touch();
        if ((result.status === 'waiting' || result.status === 'outside') && progress.expired()) {
          const snapshot = await lessonGuard.readPageState(page);
          throw lessonGuard.noProgressError(snapshot, progress);
        }
      }
      // 答完后只点明确识别到的常规结束/继续控件；点不动/变化不可见就保留窗口给用户
      if (storyDone) {
        const ending = await finishStory(page, check, target.data);
        if (ending === 'advanced') return answered;
        if (ending === 'questions') {
          // 后续又出现实际题目：交回答题逻辑
          storyDone = false;
          if (typeof storyRunner.resetDone === 'function') storyRunner.resetDone(page);
          progress.touch();
          continue;
        }
        throw new Error('STORY_DONE_NEEDS_USER 故事已完成（' + ending + '），最后结束课程需用户点击');
      }
    } else {
      const dom = await lessonRunner.readDom(page);
      // 单纯 DOM 存在不算进展：只有确认提交反馈/换题/换页才刷新计时（2026-11-20 s2u42l7 教训）
      if (dom && target.data) {
        const result = await lessonRunner.step(page, target.data, check, lexemes);
        if (result.status === 'waiting') {
          feedbackSince ??= Date.now();
          if (Date.now() - feedbackSince > 30000) throw new Error('等待普通课反馈或结算超时');
        } else {
          feedbackSince = null;
        }
        if (['answered', 'skipped', 'advanced'].includes(result.status)) {
          progress.touch();
          if (result.status === 'answered') answered++;
          if (result.status === 'skipped') skippedCount++;
          console.log('LESSON_' + result.status.toUpperCase() + (result.type ? ' type=' + result.type : '')
            + (result.evidence ? ' evidence=' + result.evidence : ''));
          stalled = 0;
          sameTick = null;
        } else if (result.status === 'nochange' || result.status === 'unknownRead') {
          // 同一题重复出现且没有任何真实推进：不 touch、不计数，按题目指纹独立 30 秒兜底。
          // 日志按「换题 / 每 10 秒」节流，避免每轮刷屏。
          const now = Date.now();
          const sig = lessonRunner.challengeSig(dom);
          const next = lessonRunner.sameTickState(sig, sameTick, now);
          const switched = !sameTick || sameTick.sig !== next.sig;
          const loggedAt = switched ? 0 : (sameTick.loggedAt || 0);
          sameTick = { sig: next.sig, since: next.since, loggedAt };
          if (switched || now - loggedAt > 10000) {
            console.log('LESSON_' + result.status.toUpperCase() + ' type=' + (dom && dom.type)
              + ' footer=' + JSON.stringify(result.footerLabel || '')
              + ' click=' + JSON.stringify(result.click || null)
              + (result.readErr ? ' readErr=' + JSON.stringify(result.readErr) : '')
              + ' waited=' + (now - next.since) + 'ms'
              + ' box=' + JSON.stringify(String((dom && dom.promptText) || (dom && dom.boxText) || '').slice(0, 80)));
            sameTick.loggedAt = now;
          }
          stalled++;
          if (next.abort) {
            throw new Error('LESSON_SAME_TICK 同一题 ' + Math.round((now - next.since) / 1000) + 's 无进展 type='
              + (dom && dom.type) + ' footer=' + JSON.stringify(result.footerLabel || '')
              + ' click=' + JSON.stringify(result.click || null)
              + (result.readErr ? ' readErr=' + JSON.stringify(result.readErr) : '')
              + ' box=' + JSON.stringify(String((dom && dom.promptText) || (dom && dom.boxText) || '').slice(0, 120)));
          }
          if (stalled >= 20) {
            throw new Error('普通题停滞 ' + result.status + ' ' + (dom && dom.type));
          }
        } else if (result.status === 'nomatch' && !nomatchLogged) {
          // 第一次认不出题就把现场留下：页面选项/题干 + 题池里同题型候选（题干命中页面的排前面）
          nomatchLogged = true;
          const pools = core.collectChallenges(target.data || {});
          const sameType = pools.filter((p) => core.normType(p.type) === core.normType(dom.type));
          const inBox = sameType.filter((p) => p.prompt && dom.boxText.includes(p.prompt));
          const near = [...inBox, ...sameType.filter((p) => !inBox.includes(p))].slice(0, 6).map((p) => ({
            type: p.type, pool: p.__pool, prompt: p.prompt,
            ans: core.textAnswers(p), opts: core.challengeOptions(p).slice(0, 12),
          }));
          console.log('NOMATCH_DETAIL ' + JSON.stringify({
            kind: result.kind, type: dom.type, hasInput: dom.hasInput,
            options: (dom.options || []).slice(0, 24), boxText: (dom.boxText || '').slice(0, 300),
            poolSize: pools.length, sameTypeCount: sameType.length, near,
          }));
          if (target.mode === 'normal' && await trySkip(page, check)) {
            skippedCount++;
            console.log('LESSON_SKIP_NOMATCH type=' + dom.type);
            stalled = 0;
          }
        } else if (result.status === 'nomatch' && target.mode === 'normal' && await trySkip(page, check)) {
          // 普通课的"新单词"教学题不在 session 里，点平台跳过继续
          skippedCount++;
          console.log('LESSON_SKIP_NOMATCH type=' + dom.type);
          stalled = 0;
        } else if (result.status === 'clickfail' || result.status === 'fillfail') {
          // 点击/填框没成功必须可诊断：带上目标控件数量与异常，不能当成作答成功
          stalled++;
          console.log('LESSON_' + result.status.toUpperCase() + ' type=' + (dom && dom.type)
            + ' chType=' + (result.chType || '-') + ' click=' + JSON.stringify(result.click || null)
            + ' box=' + JSON.stringify(String((dom && dom.boxText) || '').slice(0, 80)));
          if (stalled >= 20) {
            throw new Error('普通题停滞 ' + result.status + ' ' + (result.chType || '-') + ' ' + (dom && dom.type)
              + ' click=' + JSON.stringify(result.click || null));
          }
        } else if (result.status !== 'waiting' && ++stalled >= 20) {
          throw new Error('普通题停滞 ' + result.status + ' ' + (result.kind || '-') + ' ' + dom.type + ' ' + dom.boxText.slice(0, 120));
        }
      } else if (!dom) {
        const snapshot = await lessonGuard.readPageState(page);
        const kind = lessonGuard.classifyPage(snapshot);
        const beforeSig = screenSig(snapshot);
        // 整页加载中：这不是停滞，等它加载完，别去点 next
        if (kind === 'loading') {
          const sig = 'loading|' + beforeSig;
          if (screenSeen !== sig) {
            screenSeen = sig;
            console.log('LESSON_LOADING ' + (snapshot ? snapshot.url : ''));
          }
          nodom++;
          if (progress.expired()) throw lessonGuard.noProgressError(snapshot, progress);
          await page.waitForTimeout(2000);
          continue;
        }
        // 普通课的完成页按钮，名字和故事课不一样
        const endBtn = page.locator('[data-test="legendary-session-end-continue"]:visible');
        if (await endBtn.count().catch(() => 0)) {
          const endSig = 'end|' + beforeSig;
          if (screenSeen !== endSig) {
            screenSeen = endSig;
            console.log('LESSON_END');
          }
          await clickSafe(page, endBtn);
          await page.waitForTimeout(1500);
          const after = await lessonGuard.readPageState(page);
          if (screenSig(after) !== beforeSig) progress.touch();
          if (progress.expired()) throw lessonGuard.noProgressError(after || snapshot, progress);
          continue;
        }
        // 完成页出现「继续练习/继续学习」会开新课程：不点，保存脱敏现场退出，不结算
        const practiceBtn = page.locator(nextSelector).filter({ hasText: /继续练习|继续学习/ });
        if (await practiceBtn.count().catch(() => 0)) {
          await page.screenshot({ path: path.join(__dirname, 'lesson-continue-practice.png'), timeout: 3000 }).catch(() => {});
          throw new Error('LESSON_CONTINUE_PRACTICE 完成页出现新课程入口，未点击未结算 url=' + (new URL(page.url()).pathname));
        }
        // 正常结课后的可选传说邀请（真机：「来向我们展示你的传奇实力吧…开始 +40 经验 / 不，谢谢 / 继续」）：
        // 普通批一律选「不，谢谢」，再走正常继续/返回；不在普通批里开新传说课，也不记失败。
        if (!snapshot.hasChallenge && /展示你的传奇实力|传奇实力/.test(snapshot.text || '')) {
          const decline = page.locator('button:has-text("不，谢谢"), [role="button"]:has-text("不，谢谢")').filter({ visible: true });
          const dn = await decline.count().catch(() => 0);
          if (dn === 1) {
            const info = await decline.first().evaluate((el) => ({
              tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
              test: el.getAttribute('data-test') || '',
              text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
            })).catch(() => null);
            await check();
            console.log('LEGENDARY_INVITE_DECLINED ' + JSON.stringify(info));
            await decline.first().click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(2000);
            const after = await lessonGuard.readPageState(page);
            if (screenSig(after) !== beforeSig) progress.touch();
            if (progress.expired()) throw lessonGuard.noProgressError(after || snapshot, progress);
            continue;
          }
          if (dn > 1) throw new Error('LEGENDARY_INVITE_AMBIGUOUS candidates=' + dn);
        }
        // 分数升级过场（真机：/lesson 无 challenge/quit/player-next，文案「…离提升你的法语分数又近了一步…继续」）：
        // 确认是完成页过场才点唯一「继续」，回路径后由主循环对账；不把它当新课入口。
        if (!snapshot.hasChallenge && !snapshot.hasQuitButton && /分数|又近了一步/.test(snapshot.text || '')) {
          const cont = page.locator('button:has-text("继续"), [role="button"]:has-text("继续")').filter({ visible: true });
          const cn = await cont.count().catch(() => 0);
          if (cn === 1) {
            await check();
            console.log('LESSON_SCORE_CONTINUE');
            await cont.first().click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(2500);
            const after = await lessonGuard.readPageState(page);
            if (screenSig(after) !== beforeSig) progress.touch();
            if (progress.expired()) throw lessonGuard.noProgressError(after || snapshot, progress);
            continue;
          }
          if (cn > 1) throw new Error('LESSON_SCORE_CONTINUE_AMBIGUOUS candidates=' + cn);
        }
        const next = page.locator(nextSelector);
        if (await next.count() && await next.isEnabled()) {
          const nextSig = 'next|' + beforeSig;
          await check();
          await clickSafe(page, next);
          nodom++;
          if (screenSeen !== nextSig) {
            screenSeen = nextSig;
            console.log('LESSON_CONTINUE #' + nodom);
          }
          await page.waitForTimeout(1200);
          const after = await lessonGuard.readPageState(page);
          if (screenSig(after) !== beforeSig) progress.touch();
          if (progress.expired()) throw lessonGuard.noProgressError(after || snapshot, progress);
          continue;
        }
        // 没有题目容器、也没有可点的 next：封面/非题目页/结算动画。
        // 同一屏只记一次；超过无进展上限就抛错，原因里带页面状态，交给外层按单关故障处理。
        nodom++;
        const sig = 'nodom|' + beforeSig;
        if (screenSeen !== sig) {
          screenSeen = sig;
          console.log('LESSON_NODOM ' + JSON.stringify({ kind, ...(snapshot || {}) }));
        }
        if (progress.expired()) throw lessonGuard.noProgressError(snapshot, progress);
        await page.waitForTimeout(1000);
        continue;
      }
    }
    await page.waitForTimeout(550);
  }
  throw new Error('课程未在步数上限内回到学习路径');
}

// 故事结束控件候选：只认已知 data-test 和「结束课程」文本，不按坐标猜。
const STORY_END_SPECS = [
  '[data-test="stories-player-done"]',
  '[data-test="stories-player-continue"]',
  '[data-test="legendary-session-end-continue"]',
  'button:has-text("结束课程")',
];

// 诊断只在 --story-debug 时写临时文件；不记录 cookie/token/请求头。
function storyDebugEnabled() {
  return process.argv.includes('--story-debug');
}

function storyDiag(event) {
  if (!storyDebugEnabled()) return;
  try {
    const file = path.join(__dirname, 'story-end-debug.json');
    let prev = [];
    try {
      const old = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(old)) prev = old;
    } catch {}
    prev.push({ at: new Date().toISOString(), ...event });
    fs.writeFileSync(file, JSON.stringify(prev, null, 2));
  } catch {}
}

// 同一时刻抓候选的 locator 计数 / 可见 / 启用 / 位置，用于区分
// a（没候选）和 b（候选存在但被遮挡/不可交互）。
async function probeStoryEnd(page) {
  const state = await lessonGuard.readPageState(page);
  const candidates = [];
  for (const spec of STORY_END_SPECS) {
    const loc = page.locator(spec);
    const count = await loc.count().catch(() => -1);
    let visible = null, enabled = null, box = null;
    if (count > 0) {
      const first = loc.first();
      visible = await first.isVisible().catch(() => null);
      enabled = await first.isEnabled().catch(() => null);
      box = await first.boundingBox().catch(() => null);
    }
    candidates.push({ spec, count, visible, enabled, box });
  }
  return { state, candidates };
}

// 唯一可见且启用的候选才点；0 个 → 没找到；多个 → ambiguous，不盲点。
async function pickStoryEndControl(page) {
  const picks = [];
  for (const spec of STORY_END_SPECS) {
    const loc = page.locator(spec);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      if (!(await el.isEnabled().catch(() => false))) continue;
      picks.push({ loc: el, spec });
    }
  }
  if (picks.length === 1) return picks[0];
  if (picks.length > 1) return { ambiguous: picks.map((p) => p.spec) };
  return null;
}

// 页面签名：除了路由/前 80 字符/关键控件数量，还要带页面文本长度、stories-element 的
// 尾部内容和按钮状态。故事阅读器在底部追加行时前 80 字符和按钮都可能不变，旧签名会漏判。
async function storyUiSnapshot(page) {
  const state = await lessonGuard.readPageState(page);
  const extra = await page.evaluate(() => {
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const norm = (x) => (x || '').replace(/\s+/g, ' ').trim();
    const body = norm(document.body.innerText);
    const stories = [...document.querySelectorAll('[data-test="stories-element"]')].filter(visible);
    const parts = stories.map((e) => norm(e.innerText));
    const buttons = [...document.querySelectorAll('[data-test*="stories-player"]')].filter(visible)
      .map((b) => (b.getAttribute('data-test') || '')
        + (b.disabled || b.getAttribute('aria-disabled') === 'true' ? ':disabled' : ':enabled'));
    return {
      len: body.length,
      tail: body.slice(-160),
      storyCount: stories.length,
      storyParts: parts.map((t) => t.slice(-200)),
      buttons,
      top: window.top === window,
    };
  }).catch(() => null);
  const stateSig = lessonGuard.classifyPage(state) + '|' + ((state && state.url) || '') + '|'
    + ((state && state.text) || '').slice(0, 80);
  const presence = [];
  for (const spec of STORY_END_SPECS) {
    presence.push(await page.locator(spec).count().catch(() => -1));
  }
  const extraSig = extra && Array.isArray(extra.storyParts) && Array.isArray(extra.buttons)
    ? [extra.len, extra.storyCount, extra.storyParts.join('~'), extra.buttons.join(',')].join('|')
    : '';
  return { sig: stateSig + '|' + presence.join(',') + '|' + extraSig, state, extra, presence };
}

async function storyUiSig(page) {
  return (await storyUiSnapshot(page)).sig;
}

// 脱敏 DOM 诊断：只记控件语义（data-test / aria-label / 文本 / 容器），不记凭据。
async function dumpStoryEndDom(page) {
  if (!storyDebugEnabled()) return null;
  const data = await page.evaluate(() => {
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const items = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      if (!visible(el)) continue;
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const test = el.dataset?.test || '';
      const aria = el.getAttribute('aria-label') || '';
      if (!text && !test && !aria) continue;
      const key = test + '|' + text + '|' + aria;
      if (seen.has(key)) continue;
      seen.add(key);
      const containers = [];
      let p = el.parentElement;
      for (let i = 0; p && i < 4; i++, p = p.parentElement) {
        if (p.dataset && p.dataset.test) containers.push(p.dataset.test);
      }
      items.push({
        tag: el.tagName.toLowerCase(),
        test,
        aria,
        text,
        disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        containers,
      });
    }
    return { path: location.pathname, title: (document.title || '').slice(0, 80), items: items.slice(0, 100) };
  }).catch(() => null);
  if (!data || !Array.isArray(data.items)) return null;
  storyDiag({ event: 'dom', ...data });
  console.log('STORY_END_DOM controls=' + data.items.length + ' path=' + data.path);
  return data;
}

// 已知结束控件的存在/启用状态：用来区分「按钮暂时 disabled」和「根本没有控件」。
async function knownEndControl(page) {
  for (const spec of STORY_END_SPECS) {
    const loc = page.locator(spec);
    const count = await loc.count().catch(() => 0);
    if (!count) continue;
    const el = loc.first();
    if (!(await el.isVisible().catch(() => false))) continue;
    return { spec, enabled: await el.isEnabled().catch(() => false) };
  }
  return null;
}

// 只读记录播放器状态（不导出音频地址、不改播放策略）。
async function audioState(page) {
  return await page.evaluate(() => {
    const a = document.querySelector('audio, video');
    if (!a) return null;
    return {
      tag: a.tagName.toLowerCase(),
      paused: !!a.paused,
      currentTime: Math.round(a.currentTime || 0),
      duration: Number.isFinite(a.duration) ? Math.round(a.duration) : null,
    };
  }).catch(() => null);
}

// 收尾：用 locator.click（Playwright actionability：滚动、等可点、遮挡检测），
// 不用坐标点击、不强制点击。点后签名（含控件存在性）必须变化才继续。
async function finishStory(page, check, session) {
  // 总边界：故事元素数量 + 少量余量；不靠无条件加次数。
  const total = Array.isArray(session && session.elements) ? session.elements.length : 0;
  const maxClicks = Math.min(Math.max(total + 5, 8), 60);
  let clicks = 0;
  let sig = await storyUiSig(page);
  while (clicks < maxClicks) {
    if (LEARN.test(page.url())) return 'advanced';
    let probe = await probeStoryEnd(page);
    let picked = await pickStoryEndControl(page);
    // 已知按钮暂时禁用 ≠ 没有候选：禁用期间只等 enabled/结算信号，不点击。
    if (!picked) {
      const known = await knownEndControl(page);
      if (known) {
        let waited = 0;
        let gone = false;
        while (waited < 15 && !picked) {
          await page.waitForTimeout(1000);
          waited++;
          if (LEARN.test(page.url())) return 'advanced';
          picked = await pickStoryEndControl(page);
          if (picked) break;
          if (!(await knownEndControl(page))) { gone = true; break; }
        }
        if (!picked) {
          const audio = await audioState(page);
          storyDiag({ event: gone ? 'control-disappeared' : 'disabled-timeout', clicks, total, waited, spec: known.spec, audio });
          await dumpStoryEndDom(page);
          return gone ? 'manual control-disappeared' : 'manual disabled-timeout ' + waited + 's';
        }
        storyDiag({ event: 'control-enabled', clicks, total, waited, spec: picked.spec });
      } else {
        // 真没有控件：给渲染 5 秒，再判 no-candidate
        for (let i = 0; i < 5 && !picked; i++) {
          await page.waitForTimeout(1000);
          if (LEARN.test(page.url())) return 'advanced';
          probe = await probeStoryEnd(page);
          picked = await pickStoryEndControl(page);
        }
        if (!picked) {
          storyDiag({ event: 'no-candidate', clicks, total, route: probe.state && probe.state.url, candidates: probe.candidates });
          await dumpStoryEndDom(page);
          return 'manual no-candidate';
        }
      }
    }
    if (picked.ambiguous) {
      storyDiag({ event: 'ambiguous', clicks, total, route: probe.state && probe.state.url, specs: picked.ambiguous, candidates: probe.candidates });
      return 'manual ambiguous';
    }
    let clickError = null;
    try {
      await check();
      await picked.loc.click({ timeout: 5000 });
    } catch (e) {
      clickError = e.message;
    }
    let afterPath = '';
    try { afterPath = new URL(page.url()).pathname; } catch {}
    storyDiag({
      event: clickError ? 'click-failed' : 'clicked',
      clicks,
      total,
      spec: picked.spec,
      clickError,
      before: { route: probe.state && probe.state.url, candidates: probe.candidates },
      afterRoute: afterPath,
    });
    if (clickError) {
      await dumpStoryEndDom(page);
      return 'manual click-failed ' + picked.spec + ' ' + clickError.slice(0, 80);
    }
    // 每点一次都要看到真实推进（新尾部/活动行/按钮/URL），停滞一次即停
    let changed = false;
    let afterSnap = null;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1000);
      if (LEARN.test(page.url())) return 'advanced';
      afterSnap = await storyUiSnapshot(page);
      if (afterSnap.sig !== sig) { changed = true; sig = afterSnap.sig; break; }
    }
    storyDiag({
      event: changed ? 'story-progress' : 'clicked-no-progress',
      clicks,
      total,
      spec: picked.spec,
      after: afterSnap && afterSnap.extra,
      sigChanged: changed,
    });
    if (!changed) { await dumpStoryEndDom(page); return 'no-change ' + picked.spec; }
    clicks++;
    // 点击后出现后续实际题目：交回应答逻辑，别继续当阅读页
    const choiceCount = await page.locator('[data-test="stories-choice"]:visible').count().catch(() => 0);
    const challengeCount = await page.locator('[data-test*="challenge challenge-"]').count().catch(() => 0);
    if (choiceCount || challengeCount) {
      storyDiag({ event: 'questions-appeared', clicks, total, choiceCount, challengeCount });
      return 'questions';
    }
  }
  return LEARN.test(page.url()) ? 'advanced' : 'max-clicks';
}

// 按位置在现有进度里查真实 level（不新发请求）；位置键只用于查，不拿它当 id
function levelAt(course, sectionIndex, unitIndex, levelIndex) {
  const section = (course.pathSectioned || []).find((s) => s.index === sectionIndex);
  const unit = (section && section.units || []).find((u) => u.unitIndex === unitIndex);
  return (unit && unit.levels || [])[levelIndex] || null;
}

// 普通课里 session 没有对应条目的题（如"新单词"教学题），点平台跳过
async function trySkip(page, check) {
  const sk = page.locator('[data-test="player-skip"]:visible');
  if (await sk.count() !== 1 || !(await sk.isEnabled().catch(() => false))) return false;
  await check();
  await clickSafe(page, sk);
  await page.waitForTimeout(700);
  const nxt = page.locator(nextSelector).filter({ hasText: /^\s*继续\s*$/ });
  if (await nxt.count() === 1 && await nxt.isEnabled().catch(() => false)) {
    await check();
    await clickSafe(page, nxt);
    await page.waitForTimeout(300);
  }
  return true;
}

// radio 待处理/成功关键字：外层 catch 按前缀决定“本次运行不再重试这一关”。
// 只有 RADIO_ADVANCED 是成功（console.log，不抛错）；其余都表示没拿到推进证据。
const RADIO_PENDING = /^(RADIO_UNSUPPORTED|RADIO_SKIP_CLICK_FAILED|RADIO_SKIP_NO_CHANGE|RADIO_NO_PROGRESS|RADIO_INTRO_TIMEOUT|RADIO_NEXT_CLICK_FAILED|RADIO_NEXT_AMBIGUOUS|RADIO_WRONG_PAGE|RADIO_TAP_AMBIGUOUS|RADIO_TAP_NO_FEEDBACK|RADIO_TAP_NOT_MATCH)\b/;

// 点「开始」之后等真正的课程界面：题目/挑战容器出现才算推进。
// 不新发网络请求，只读页面状态；离开 /lesson（回首页/别的页面）立刻返回交给上层判误导航。
async function waitForCourseScreen(page, tries = 12) {
  let state = null;
  let kind = 'unknown';
  for (let i = 0; i < tries; i++) {
    state = await lessonGuard.readPageState(page);
    kind = lessonGuard.classifyPage(state);
    if (kind === 'question') return { state, kind };
    if (state && !/^\/lesson(?:\/|$)/.test((state.url || '').split('?')[0])) return { state, kind };
    await page.waitForTimeout(1000);
  }
  return { state, kind };
}

// 普通课入口：/lesson 直接进当前 active 节点（不能像传奇那样构造 unit/level URL，那个 404）
// 延后 radio：路径上点它 → 「稍后选择」 → 同一 unit 往后找第一个有「开始」入口的节点并进课。
// 接口会把 radio 报 active、下一节点 locked，但网页上下一节点已有可点的开始（Codex 实测）。
// 记录规则（验收补正）：点「稍后选择」本身不是成功证据，弹窗收起/URL 变化也不算。
// 只有同一 unit 的正确后续节点打开、点「开始」成功、并且题目/挑战容器真的出现，
// 才打唯一一条 RADIO_ADVANCED（带下一节点 id 和页面证据）。拿不到证据一律抛错，
// 由外层按待处理记录（不记成功、本次运行不再重试这一关）。
async function prepareDeferredRadio(page, check, slot, onTarget) {
  await check();
  await page.goto(ORIGIN + '/learn', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  // 学习路径是客户端渲染的，法语课常见要 7-9 秒才出现；3 秒时 unit 还不存在
  const unit = page.locator('[data-test="skill-path-unit-' + slot.unitIndex + '"]').first();
  await unit.waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await unit.scrollIntoViewIfNeeded({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(800);
  const radio = unit.locator('[data-test="skill-path-level-' + slot.levelIndex + ' skill-path-level-duo_radio"]').first();
  // 节点可能在 unit 底部之外：先滚动到可视区再点，避免点到被裁剪的位置
  await radio.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(600);
  // 气泡/入口是客户端渲染，偶尔点击没展开：最多点两次，每次轮询 8 秒等真实入口
  const later = page.locator('button:has-text("稍后选择"), [role="button"]:has-text("稍后选择")').filter({ visible: true }).first();
  const selfAll = unit.locator('a[data-test*="skill-path-state"]').filter({ visible: true });
  let picks = [];
  let laterCount = 0;
  for (let clickTry = 0; clickTry < 2; clickTry++) {
    await radio.click({ timeout: 6000 }).catch(() => {});
    for (let w = 0; w < 8; w++) {
      await page.waitForTimeout(1000);
      laterCount = await later.count().catch(() => 0);
      if (laterCount) break;
      const selfCount = await selfAll.count().catch(() => 0);
      picks = [];
      for (let i = 0; i < selfCount; i++) {
        const el = selfAll.nth(i);
        const text = String(await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (!(await el.isEnabled().catch(() => false))) continue;
        picks.push({ loc: el, text });
      }
      if (picks.length) break;
    }
    if (laterCount || picks.length) break;
  }
  if (!laterCount) {
    // 没有「跳过内容」入口时走电台自己的常规入口（如「听力练习 +30 经验」），
    // 只有唯一、有文本、标题与目标节点匹配的入口才点。
    if (picks.length !== 1) throw new Error('RADIO_UNSUPPORTED 无跳过入口，电台自身入口不唯一 candidates=' + picks.length);
    const unitText = String(await unit.evaluate((el) => (el.innerText || '').replace(/\s+/g, ' ').trim()).catch(() => ''));
    if (!unitText.includes(String(slot.name || '').trim())) {
      throw new Error('RADIO_UNSUPPORTED 电台自身入口标题不匹配目标节点 name=' + slot.name);
    }
    await check();
    await picks[0].loc.click({ timeout: 5000 });
    await page.waitForURL((url) => url.origin === ORIGIN && url.pathname === '/lesson', { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1000);
    if (!/\/lesson/.test(page.url())) throw new Error('RADIO_NO_PROGRESS 电台自身入口未进入 /lesson');
    console.log('RADIO_DIRECT id=' + slot.id + ' entry=' + JSON.stringify(picks[0].text));
    return { url: new URL(page.url()), deferred: true, skipped: false, radioDirect: true };
  }
  const beforeUrl = page.url();
  const beforeText = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300)).catch(() => '');
  let clicked = false;
  try {
    await later.click({ timeout: 5000 });
    clicked = true;
  } catch (e) {}
  if (!clicked) throw new Error('RADIO_SKIP_CLICK_FAILED 点击「稍后选择」失败');
  await page.waitForTimeout(2500);
  // 弹窗收起只是必要条件，不是推进证据。完全没变化才判 RADIO_SKIP_NO_CHANGE。
  const afterUrl = page.url();
  const afterText = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300)).catch(() => '');
  const laterGone = (await later.count().catch(() => 1)) === 0;
  if (!laterGone && afterUrl === beforeUrl && afterText === beforeText) {
    throw new Error('RADIO_SKIP_NO_CHANGE 点击「稍后选择」后页面未变化');
  }
  // 复用路径 DOM 上的节点状态（不发新请求）：同一 unit 往后第一个能点开且有「开始」的节点。
  for (let li = slot.levelIndex + 1; li <= slot.levelIndex + 4; li++) {
    const nextId = 's' + (slot.sectionIndex ?? 0) + 'u' + slot.unitIndex + 'l' + li;
    const node = unit.locator('[data-test^="skill-path-level-' + li + ' "]').first();
    if (!(await node.count())) continue;
    try {
      await node.click({ timeout: 6000 });
    } catch (e) {
      throw new Error('RADIO_NEXT_CLICK_FAILED next=' + nextId + ' step=node');
    }
    await page.waitForTimeout(2000);
    // 入口是 <a data-test="skill-path-state-active ...">开始 +10 经验</a>，不是按钮。
    // 先数候选总数：多个「开始」同时可见时，现有 DOM 无法唯一对应到刚选中的节点，
    // 盲点第一个可能点错节点，所以保守拦截为待处理（精确关联留阶段二）。
    const starts = page.locator('a[data-test*="skill-path-state-active"]').filter({ hasText: '开始' }).filter({ visible: true });
    const startCount = await starts.count();
    if (!startCount) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
      continue;
    }
    if (startCount > 1) {
      throw new Error('RADIO_NEXT_AMBIGUOUS next=' + nextId + ' candidates=' + startCount);
    }
    // 点「开始」之前用现有进度查出真实后继（UUID + 类型），并绑定到作答上下文；
    // 禁止位置键当 id，也禁止导航后再从已消失的节点读类型。
    const nextSlot = onTarget ? onTarget(li) : null;
    if (!nextSlot || !nextSlot.id) {
      throw new Error('RADIO_NEXT_IDENTITY_MISSING next=' + nextId);
    }
    const start = starts.first();
    try {
      await start.click({ timeout: 5000 });
    } catch (e) {
      throw new Error('RADIO_NEXT_CLICK_FAILED next=' + nextId + ' step=start');
    }
    // 练习/复习的课程介绍页（真机：「来巩固一下你最薄弱的语法知识点吧！…开始练习」）：
    // 点唯一「开始练习」再等题目容器，复用普通入口的按钮体系，不另造一套。
    const practiceStart = page.locator('button:has-text("开始练习"), [role="button"]:has-text("开始练习")').filter({ visible: true });
    for (let w = 0; w < 8; w++) {
      await page.waitForTimeout(1000);
      const ps = await practiceStart.count().catch(() => 0);
      if (ps === 1) {
        await check();
        console.log('RADIO_NEXT_PRACTICE_INTRO next=' + nextId);
        await practiceStart.first().click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(2500);
        break;
      }
      if (ps > 1) throw new Error('RADIO_NEXT_AMBIGUOUS next=' + nextId + ' practiceStart=' + ps);
      const st = await lessonGuard.readPageState(page);
      if (lessonGuard.classifyPage(st) === 'question') break;
    }
    // 成功判定顺序：先确认仍在课程路由，再确认题目/挑战容器出现；缺一不可。
    const { state, kind } = await waitForCourseScreen(page);
    if (state && !/^\/lesson\/?$/.test((state.url || '').split('?')[0])) {
      throw new Error('RADIO_WRONG_PAGE next=' + nextId + ' url=' + (state.url || '未知'));
    }
    if (!state || kind !== 'question') {
      throw new Error('RADIO_NO_PROGRESS next=' + nextId + ' reason=课程界面未出现题目容器 ' + lessonGuard.describePage(state));
    }
    console.log('RADIO_ADVANCED id=' + slot.id + ' next=' + nextSlot.id + ' type=' + nextSlot.type + ' evidence=question url=' + state.url);
    return { url: new URL(page.url()), deferred: true, skipped: true, advanced: true, nextId: nextSlot.id, nextSlot };
  }
  throw new Error('RADIO_NO_PROGRESS reason=弹窗已收起但未找到可进入的下一节点');
}

const normalizeEllipsis = (s) => String(s || '')
  .replace(/\u2026/g, '...')
  .replace(/\s*\.\.\.\s*/g, '...')
  .replace(/\s+/g, ' ')
  .trim();

// 普通故事换节点真实入口：/learn → 目标 unit → 目标 level 节点（token 匹配）→ 点开气泡 →
// 核对气泡属于同一节点（同 unit、点后出现、标题匹配平台本地化 storyName）且只有唯一「开始」。
// 任何一步证不出来就抛 NODE_ENTRY_*，一次收口、不回退直开 /lesson。
async function prepareByStoryNode(page, check, slot, level) {
  await check();
  const storyName = level?.pathLevelClientData?.storyName || '';
  if (!storyName) throw new Error('NODE_ENTRY_UNSUPPORTED 缺少 pathLevelClientData.storyName');
  await page.goto(ORIGIN + '/learn', { waitUntil: 'domcontentloaded', timeout: 20000 });
  const unit = page.locator('[data-test~="skill-path-unit-' + slot.unitIndex + '"]').first();
  await unit.waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await unit.scrollIntoViewIfNeeded({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(500);
  const nodes = unit.locator('[data-test~="skill-path-level-' + slot.levelIndex + '"]');
  const nodeCount = await nodes.count();
  if (nodeCount !== 1) throw new Error('NODE_ENTRY_AMBIGUOUS nodes=' + nodeCount);
  const node = nodes.first();
  const meta = await node.evaluate((el) => ({ test: el.getAttribute('data-test') || '' }));
  const tokens = String(meta.test || '').split(/\s+/);
  if (tokens.some((t) => /^skill-path-unit-test/.test(t))) {
    throw new Error('NODE_ENTRY_UNMATCHED unit-test 候选 test=' + meta.test);
  }
  const typeOk = tokens.some((t) => t === 'skill-path-level-' + slot.type || t.startsWith('skill-path-level-' + slot.type));
  if (!typeOk) throw new Error('NODE_ENTRY_UNMATCHED 类型不符 type=' + slot.type + ' test=' + meta.test);
  const activeOk = tokens.includes('skill-path-state-active') || level.state === 'active';
  if (!activeOk) throw new Error('NODE_ENTRY_UNMATCHED 非 active test=' + meta.test);
  const before = await unit.evaluate(() => {
    const visible = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    return { starts: [...document.querySelectorAll('a[data-test*="skill-path-state-active"]')].filter(visible).map((a) => a.getAttribute('data-test') || '') };
  }).catch(() => null);
  await node.click({ timeout: 6000 });
  await page.waitForTimeout(1500);
  const after = await unit.evaluate((el, name) => {
    const visible = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const starts = [...el.querySelectorAll('a[data-test*="skill-path-state-active"]')].filter(visible);
    // 气泡里的「开始」data-test 可能带 skill-path-unit-test-71，它是这个单元的入口标识，
    // 不是外来节点；归属已由“同 unit + 点后出现 + 标题匹配 storyName”证明。
    // href 只记路径和参数名，不记查询参数的值。
    return {
      starts: starts.map((a) => {
        let pathname = '', params = [];
        try {
          const u = new URL(a.getAttribute('href') || a.href, location.origin);
          pathname = u.pathname;
          params = [...u.searchParams.keys()];
        } catch {}
        const box = a.closest('[data-test]');
        return {
          test: a.getAttribute('data-test') || '',
          text: norm(a.innerText).slice(0, 40),
          pathname,
          params,
          box: box ? (box.getAttribute('data-test') || '') : '',
        };
      }),
      text: norm(el.innerText).slice(0, 300),
    };
  }, storyName).catch(() => null);
  const hasTitle = !!after && normalizeEllipsis(after.text).includes(normalizeEllipsis(storyName));
  storyDiag({ event: 'story-node-entry', nodeTest: meta.test, type: slot.type, state: level.state, before, after, storyName, hasTitle });
  if (!after) throw new Error('NODE_ENTRY_UNMATCHED 读不到气泡');
  if (after.starts.length !== 1) throw new Error('NODE_ENTRY_AMBIGUOUS starts=' + after.starts.length);
  if (!hasTitle) throw new Error('NODE_ENTRY_UNMATCHED 气泡标题不匹配 storyName=' + storyName);
  // href 必须是正常课程入口；指向单元测试/跳级/确认页/无路径时不点
  const hrefPath = after.starts[0].pathname || '';
  if (!hrefPath || /unit-test|\/test\b|checkpoint|verify|confirm|skip/i.test(hrefPath)) {
    throw new Error('NODE_ENTRY_UNSAFE href 指向异常 pathname=' + hrefPath);
  }
  const startTest = after.starts[0].test;
  const start = unit.locator('[data-test="' + startTest + '"]').filter({ visible: true }).first();
  if (!(await start.count())) throw new Error('NODE_ENTRY_UNMATCHED 找不到已确认的开始入口');
  await check();
  await start.click({ timeout: 5000 });
  await page.waitForURL((url) => url.origin === ORIGIN && url.pathname === '/lesson', { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const url = new URL(page.url());
  if (url.pathname !== '/lesson') throw new Error('NODE_ENTRY_NO_LESSON 点击开始后未进入 /lesson url=' + url.pathname);
  return { button: null, url, nodeEntry: true };
}

async function prepareNormal(page, check, slot, level, onTarget) {
  await check();
  if (slot && slot.type === 'story' && process.argv.includes('--node-entry')) return await prepareByStoryNode(page, check, slot, level);
  if (slot && slot.type === 'duo_radio') return await prepareDeferredRadio(page, check, slot, onTarget);
  // 宝箱：/lesson 会回路径并显示「打开」，点掉就解锁下一节点（不给 XP）
  if (slot && slot.type === 'chest') {
    await page.goto(ORIGIN + '/learn', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const open = page.locator('button:has-text("打开")').filter({ visible: true }).first();
    if (!(await open.count())) throw new Error('宝箱没有「打开」入口');
    await clickSafe(page, open);
    await page.waitForTimeout(3000);
    return { chest: true, url: new URL(page.url()) };
  }
  await page.goto(ORIGIN + '/lesson', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3500);
  if (!/\/lesson/.test(page.url())) throw new Error('普通课入口没有进入 /lesson');
  // 练习/复习的介绍页（真机：「来巩固一下你最薄弱的语法知识点吧！…开始练习」）：
  // 点唯一「开始练习」再等题目容器，不把「没进 /lesson 课程」误判成入口失败。
  const practiceStart = page.locator('button:has-text("开始练习"), [role="button"]:has-text("开始练习")').filter({ visible: true });
  if (await practiceStart.count().catch(() => 0) === 1) {
    await clickSafe(page, practiceStart);
    await page.waitForTimeout(2500);
    return { button: null, url: new URL(page.url()), practiceIntro: true };
  }
  const start = page.locator('[data-test="player-next"]:visible').first();
  const button = await start.count() ? start : null;
  return { button, url: new URL(page.url()) };
}

async function main() {
  const minutes = numberArg('minutes', 0.001);
  const xp = numberArg('xp', 1);
  const fromSection = numberArg('from-section', 0) ?? 0;
  const fromUnit = numberArg('from-unit', 0) ?? 0;
  const fromLevel = numberArg('from-level', 0) ?? 0;
  const maxLessons = numberArg('max-lessons', 1) ?? Infinity;
  if (!minutes && !xp) throw new Error('必须给 --minutes 或 --xp 上限');

  const startedAt = Date.now();
  // --normal：从零做普通课（/lesson 进当前 active 节点）；默认刷传奇课
  const mode = process.argv.includes('--normal') ? 'normal' : 'legendary';
  // 本次运行内确定进不去的节点（传奇入口已消失），不再重试
  const skipped = new Set();
  // 节点维度与批次维度的失败计数分开：同节点 2 次失败换节点，5 个不同节点连续失败才停
  const retry = policy.createRetryTracker();
  const select = course => (mode === 'normal' ? policy.planNormal(course) : policy.planCourse(course).candidates).filter(slot =>
    !skipped.has(slot.id) && !retry.skipped.has(slot.id) && slot.sectionIndex >= fromSection && slot.unitIndex >= fromUnit
    && (slot.unitIndex !== fromUnit || slot.levelIndex >= fromLevel));
  if (process.argv.includes('--dry-run')) {
    const course = JSON.parse(fs.readFileSync(path.join(__dirname, 'course-path.json'), 'utf8'));
    const queue = select(course);
    console.log(JSON.stringify({ mode: 'dry-run', count: queue.length, first: queue.slice(0, 5) }, null, 2));
    return;
  }

  // 本机 macOS 27 上 Playwright 自带 Chrome for Testing 156 有头启动即 SIGTRAP，改用系统 Chrome
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'profile'), {
    executablePath: fs.existsSync(systemChrome) ? systemChrome : undefined,
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--no-proxy-server'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  // 故事走到必须人工点结束的情况：保留专用窗口和当前页面，不在 finally 里关浏览器
  let keepOpen = false;
  let uid;
  let active;
  let restriction;
  let initialProgress;
  const seenSessions = new Set();
  // radio 等待后继节点期间可能先到练习 session：按后继身份核对后再交给新目标，不能丢
  let latePracticeSession = null;

  // 只读诊断：JS 错误种类（不记录页面内容/凭据）
  if (storyDebugEnabled()) {
    page.on('pageerror', (err) => {
      console.log('STORY_JS_ERROR ' + (err && err.name ? err.name : 'Error') + ' ' + String(err && err.message || '').slice(0, 100));
    });
  }
  page.on('response', async response => {
    const url = new URL(response.url());
    const onSite = url.origin === ORIGIN;
    const story = url.hostname === 'stories.duolingo.com' && url.pathname.startsWith('/api2/stories/');
    const user = onSite && url.pathname.match(/^\/2023-05-23\/users\/(\d+)$/);
    const session = onSite && /^\/2023-05-23\/sessions(?:\/|$)/.test(url.pathname);
    const lexicon = onSite && /practice-lexemes/.test(url.pathname);
    const document = onSite && response.request().resourceType() === 'document';
    if ((story || user || session || document) && [401, 403, 429].includes(response.status())) {
      restriction ||= '关键请求 HTTP ' + response.status() + ' ' + url.pathname;
      return;
    }
    const target = active;
    if (storyDebugEnabled() && (document || story) && !/\/(login|verify|checkpoint)/.test(url.pathname)) {
      console.log('STORY_HTTP ' + response.request().method() + ' ' + url.pathname + ' ' + response.status());
    }
    if ((!user && !session && !story && !lexicon) || !response.ok()) return;
    try {
      const data = await response.json();
      if (lexicon && Array.isArray(data.practiceLexemes)) {
        lexemes = data.practiceLexemes;
        console.log('LEXEMES count=' + lexemes.length);
      }
      if (user && data.currentCourse?.pathSectioned && Number.isFinite(data.totalXp)) {
        uid = user[1];
        initialProgress ||= { course: data.currentCourse, xp: data.totalXp };
      }
      if (session && Array.isArray(data.challenges)) {
        console.log('SESSION_SEEN type=' + data.type + ' n=' + data.challenges.length
          + ' skillId=' + (data.skillId || '-') + ' levelIndex=' + (data.levelIndex ?? '-'));
        if (data.id && !seenSessions.has(data.id)) {
          sessionCache.set((data.skillId || '') + '|' + (data.levelIndex ?? ''), data);
        }
      }
      if (!target || target !== active || target.data) return;
      // 电台只用 elements 形状的 session；普通练习的 challenges session 不能占位，
      // 否则第二次走 radio-direct 时真正的电台 session 会被 !target.data 挡掉
      if (target.slot.type === 'duo_radio' && session && Array.isArray(data.elements)) {
        target.data = data;
        console.log('RADIO_SESSION elements=' + data.elements.length);
      }
      if (target.slot.type === 'duo_radio' && session && Array.isArray(data.challenges)) {
        latePracticeSession = data;
        console.log('LATE_PRACTICE_SESSION type=' + data.type + ' n=' + data.challenges.length);
      }
      if (target.slot.type === 'story' && story && Array.isArray(data.elements)
          && decodeURIComponent(url.pathname.split('/').at(-1)) === target.level.pathLevelMetadata?.storyId) {
        target.data = data;
        console.log('STORY_DATA elements=' + data.elements.length);
      }
      if (target.slot.type !== 'story' && target.slot.type !== 'duo_radio' && session && Array.isArray(data.challenges) && data.id && !seenSessions.has(data.id)) {
        const meta = target.level.pathLevelMetadata || {};
        let matched;
        if (mode === 'normal') {
          if (target.slot.type === 'skill' || target.slot.type === 'story') {
            // 普通课：LESSON/LEVEL_REVIEW，按当前 active 节点的 skillId/crownLevelIndex 认
            matched = /^(LESSON|LEVEL_REVIEW)/.test(data.type || '') && data.skillId === meta.skillId && data.levelIndex === meta.crownLevelIndex;
          } else {
            // 练习/单元复习：LEXEME_PRACTICE，没有 skillId/levelIndex 可对，页面进了 /lesson 就认
            matched = /^(LEXEME_PRACTICE|UNIT_PRACTICE|LEXEME_REVIEW|UNIT_REVIEW|LESSON|LEVEL_REVIEW)/.test(data.type || '');
          }
        } else if (target.slot.type === 'skill') {
          matched = /^LEGENDARY/.test(data.type || '') && data.skillId === meta.skillId && data.levelIndex === meta.crownLevelIndex;
        } else {
          // 复习/单元复习的 session 是 LEGENDARY_LEXEME_PRACTICE，里面没有 skillId/levelIndex 可对，
          // 既然页面已经导航到这节的 URL，就认这个 session
          matched = /^LEGENDARY/.test(data.type || '');
        }
        if (!matched) return;
        seenSessions.add(data.id);
        target.data = data;
        console.log('LESSON_DATA type=' + target.slot.type + ' challenges=' + data.challenges.length + ' skillId=' + data.skillId + ' levelIndex=' + data.levelIndex);
      }
    } catch {
      // Some session responses contain only completion status.
    }
  });

  const check = async () => {
    if (restriction) throw new Error(restriction);
    // page.evaluate 卡住会永久挂住整个循环，加 15 秒上限让它变成可跳过的单关故障
    const blocked = await Promise.race([
      page.evaluate(() => {
        if (/^\/(login|checkpoint|verify)(\/|$)/.test(location.pathname)) return location.pathname;
        for (const frame of document.querySelectorAll('iframe[src*="/recaptcha/"][src*="/bframe"]')) {
          const rect = frame.getBoundingClientRect();
          const style = getComputedStyle(frame);
          if (rect.width > 0 && rect.height > 0 && style.visibility === 'visible' && style.opacity !== '0') {
            return '可见人机验证';
          }
        }
        return '';
      }).catch(() => ''),
      new Promise((_, reject) => setTimeout(() => reject(new Error('页面无响应（15 秒未返回）')), 15000)),
    ]);
    if (blocked) throw new Error(blocked);
  };

  const readProgress = async (slot) => {
    await check();
    const result = await page.evaluate(async id => {
      const response = await fetch('/2023-05-23/users/' + id + '?fields=currentCourse,totalXp', {
        credentials: 'include',
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('读取进度 HTTP ' + response.status);
      const data = await response.json();
      return { course: data.currentCourse, xp: data.totalXp };
    }, uid);
    await check();
    if (!Array.isArray(result.course?.pathSectioned) || !Number.isFinite(result.xp)) {
      throw new Error('进度响应缺少课程或 XP');
    }
    const lv = slot ? findCourseLevel(result.course, slot) : null;
    return {
      ...result,
      node: lv ? { state: lv.state, finishedSessions: lv.finishedSessions ?? null, totalSessions: lv.totalSessions ?? null } : null,
    };
  };
  const nodeSessions = (course, slot) => {
    const lv = findCourseLevel(course, slot);
    return lv ? { state: lv.state, finished: lv.finishedSessions ?? null, total: lv.totalSessions ?? null } : null;
  };

  // 链口径（2026-11-19）：链头已金 / 整链已金 / pending 逐节点；入口证据三态运行时收集
  const entryEvidence = new Map();
  const logChains = (course) => {
    try {
      const r = policy.chainReport(course, entryEvidence);
      console.log('CHAIN_REPORT headsGold=' + r.headsGold + ' chainsGold=' + r.chainsGold
        + ' pending=' + r.pending.length + ' ready=' + r.ready.length + ' absent=' + r.absent.length + ' unknown=' + r.unknown.length
        + ' courseNotGold=' + r.courseNotGold);
      if (r.ready.length) console.log('CHAIN_READY ' + JSON.stringify(r.ready.slice(0, 10)));
      if (r.absent.length) console.log('CHAIN_ABSENT ' + JSON.stringify(r.absent.slice(0, 10)));
      if (r.unknown.length) console.log('CHAIN_UNKNOWN ' + JSON.stringify(r.unknown.slice(0, 10)));
    } catch (e) { console.log('CHAIN_REPORT_FAILED ' + e.message); }
  };

  try {
    await page.goto(ORIGIN + '/learn', { waitUntil: 'domcontentloaded', timeout: 20000 });
    for (let attempt = 0; attempt < 30 && !initialProgress; attempt++) {
      await check();
      await page.waitForTimeout(500);
    }
    if (!initialProgress) throw new Error('未收到已登录账号的课程进度');

    let progress = initialProgress;
    const startXp = progress.xp;
    const courseId = progress.course.id;
    const budget = () => policy.stopDecision({ startedAt, startXp, currentXp: progress.xp, minutes, xp });
    console.log('START xp=' + startXp + ' course=' + courseId);
    for (let completed = 0; completed < maxLessons;) {
      if (!budget().mayStartNext) {
        logChains(progress.course); console.log('STOP ' + JSON.stringify(budget()));
        return;
      }
      if (progress.course.id !== courseId) throw new Error('当前课程已切换');
      const slot = select(progress.course)[0];
      if (!slot) {
        logChains(progress.course);
        console.log('STOP 没有待做节点');
        return;
      }
      const level = findCourseLevel(progress.course, slot);
      // 实际作答/结算目标：radio 跳过到后继节点时切换成 lessonSlot，radio 只保留自己的结论
      let lessonSlot = slot;
      // 点后继「开始」之前绑定真实目标（UUID/类型来自现有进度），让随后的 session 直接落到它身上
      const bindTarget = (li) => {
        const lv = levelAt(progress.course, slot.sectionIndex, slot.unitIndex, li);
        if (!lv) return null;
        const t = {
          courseId: slot.courseId, sectionIndex: slot.sectionIndex, unitIndex: slot.unitIndex,
          levelIndex: li, id: lv.id, type: lv.type, name: lv.debugName,
        };
        lessonSlot = t;
        const late = latePracticeSession && latePracticeSession.id && !seenSessions.has(latePracticeSession.id)
          && /^(LEXEME_PRACTICE|UNIT_PRACTICE|UNIT_REVIEW|LEXEME_REVIEW|LESSON|LEVEL_REVIEW)/.test(latePracticeSession.type || '')
          ? latePracticeSession : null;
        if (late) seenSessions.add(late.id);
        active = { slot: t, level: findCourseLevel(progress.course, t), data: late, mode };
        console.log('RADIO_BIND_TARGET origin=' + slot.id + ' target=' + t.id + ' type=' + t.type + ' lateSession=' + (late ? late.type : 'none'));
        return t;
      };
      active = { slot, level, data: null, mode };
      // 普通课/传奇课都先看预加载缓存：/lesson 有时根本不发新 session（页面直接用预加载那份）
      const meta = level?.pathLevelMetadata || {};
      const cached = sessionCache.get((meta.skillId || '') + '|' + (meta.crownLevelIndex ?? ''));
      if (cached && !seenSessions.has(cached.id)
          && (mode === 'normal'
            ? /^(LESSON|LEVEL_REVIEW|LEXEME_PRACTICE|UNIT_PRACTICE|LEXEME_REVIEW|UNIT_REVIEW)/.test(cached.type || '')
            : /^LEGENDARY/.test(cached.type || ''))) {
        active.data = cached;
        seenSessions.add(cached.id);
        console.log('SESSION_CACHED type=' + cached.type + ' n=' + cached.challenges.length);
      }
      try {
      const entry = mode === 'normal' ? await prepareNormal(page, check, slot, level, bindTarget) : await prepareByNode(page, slot, check);
      if (mode !== 'normal') entryEvidence.set(slot.id, 'observed-present');
      console.log('ENTRY s' + slot.sectionIndex + 'u' + slot.unitIndex + 'l' + slot.levelIndex + ' ' + slot.name + ' → ' + entry.url.pathname + (entry.chest ? ' (chest)' : '') + (entry.skipped ? ' (radio-skip)' : '') + (entry.radioDirect ? ' (radio-direct)' : '') + (entry.entryLabel ? ' entry=' + JSON.stringify(entry.entryLabel) : ''));
      if (entry.radioDirect) active.radioDirect = true;
      // radio 跳过到同单元后继节点：bindTarget 已在点「开始」前切换目标，这里只确认身份
      if (entry.nextSlot) {
        lessonSlot = entry.nextSlot;
        console.log('RADIO_SWITCH_TARGET target=' + lessonSlot.id + ' type=' + lessonSlot.type);
      }
      if (!budget().mayStartNext) {
        logChains(progress.course); console.log('STOP ' + JSON.stringify(budget()));
        return;
      }
      await check();
      console.log('NODE_SESSIONS before id=' + lessonSlot.id + ' ' + JSON.stringify(nodeSessions(progress.course, lessonSlot)));
      active.startedAt = Date.now();
      let answered = 0;
      if (!entry.chest) {
        if (entry.deferred) {
          await page.waitForTimeout(2000);
        } else if (entry.button) {
          await clickSafe(page, entry.button, 4);
          // 点「开始」后目标是进入课程页：只要求路径是 /lesson（可能带尾斜杠/查询参数），
          // 不拿准备阶段读到的 pathname 做全等比较（unit 73 l10 实测 25 秒超时但页面其实已在 /lesson）。
          await page.waitForURL(url => url.origin === ORIGIN && url.pathname.startsWith('/lesson'), { timeout: 45000 })
            .catch(() => console.log('ENTRY_URL_WAIT_MISMATCH wanted=/lesson actual=' + new URL(page.url()).pathname));
          if (!/\/lesson/.test(page.url())) throw new Error('点击开始后未进入 /lesson url=' + page.url().slice(0, 80));
        }
        answered = await solve(page, active, check);
      }

      const before = progress.xp;
      const wantState = mode === 'normal' ? 'passed' : 'legendary';
      for (let attempt = 0; attempt < 3; attempt++) {
        progress = await readProgress(lessonSlot);
        const levelState = findCourseLevel(progress.course, lessonSlot)?.state;
        if (progress.xp > before && (mode === 'normal' || levelState === wantState)) break;
        if (attempt < 2) await page.waitForTimeout(1200);
      }
      const state = findCourseLevel(progress.course, lessonSlot)?.state;
      // 普通课一个 skill 节点要多次会话才 passed（totalSessions 常见 4），单节成功以 XP 到账为准；
      // 宝箱打开不给 XP，只有 state 从 active 变 passed，所以 state 变化也算结算
      if (mode === 'normal') {
        if (progress.xp <= before && state === 'active') {
          throw new Error('未确认目标结算 id=' + lessonSlot.id + ' state=' + state + ' XP变化=' + (progress.xp - before));
        }
      } else if (progress.xp <= before || state !== wantState) {
        throw new Error('未确认目标结算 id=' + lessonSlot.id + ' state=' + state + ' XP变化=' + (progress.xp - before));
      }
      completed++;
      retry.ok(lessonSlot.id);
      console.log('NODE_SESSIONS after id=' + lessonSlot.id + ' ' + JSON.stringify(nodeSessions(progress.course, lessonSlot)));
      active = null;
      console.log('SETTLED id=' + lessonSlot.id + ' state=' + state + ' xp=' + progress.xp + ' delta=' + (progress.xp - before) + ' answered=' + answered + ' sessions=' + JSON.stringify(progress.node || null) + (lessonSlot.id !== slot.id ? ' origin=' + slot.id : '') + (entry.advanced ? ' radio=advanced next=' + entry.nextId : ''));
      } catch (error) {
        // 故事题已全部答完、结束按钮不在或不可点：按用户约定收尾，不重试、不轮询
        if (/RADIO_QUIZ_BLOCKED|RADIO_TAP_PARTIAL/.test(error.message)) {
          keepOpen = true;
          console.log('STOP radio-blocked（' + error.message.slice(0, 120) + '；窗口保留）');
          return;
        }
        if (/STORY_DONE_NEEDS_USER/.test(error.message)) {
          keepOpen = true;
          console.log('STOP story-done（最后结束课程需用户点击）');
          console.log('STORY_END_REASON ' + error.message.replace(/^STORY_DONE_NEEDS_USER\s*/, ''));
          return;
        }
        // 平台限制/验证一律终止；单关故障（超时、确认不到结算）只跳过这一关
        if (/restriction|验证|reCAPTCHA|\b(401|403|429)\b|登录/.test(error.message)) throw error;
        // 浏览器被关掉（手动关窗或崩溃）就没法继续了，干净退出而不是当单关故障重试
        if (/has been closed|Target page|Browser has been closed/i.test(error.message) || page.isClosed()) {
          console.log('BROWSER_CLOSED 停止（浏览器已关闭）');
          return;
        }
        // 节点入口证不出来（还没进课）：一次收口，不循环重试 8 次
        const nodeFail = /^(NODE_ENTRY_UNSUPPORTED|NODE_ENTRY_AMBIGUOUS|NODE_ENTRY_UNMATCHED|NODE_ENTRY_NO_LESSON)\b/.exec(error.message);
        if (nodeFail) {
          const detail = error.message.replace(new RegExp('^' + nodeFail[1] + '\\s*'), '');
          console.log(nodeFail[1] + ' id=' + slot.id + ' ' + detail);
          console.log('NODE_ENTRY_STOP 一次收口，未进入课程');
          return;
        }
        // radio 跳过失败/无推进证据：本次运行标记待处理，不再猜下一节点
        const radioFail = RADIO_PENDING.exec(error.message);
        if (radioFail) {
          skipped.add(slot.id);
          const detail = error.message.replace(new RegExp('^' + radioFail[1] + '\\s*'), '');
          console.log(radioFail[1] + ' id=' + slot.id + ' ' + detail);
          active = null;
          progress = await readProgress().catch(() => progress);
          await page.goto(ORIGIN + '/learn', { timeout: 45000 }).catch(() => {});
          await page.waitForTimeout(2000);
          continue;
        }
        // 节点气泡里没有 legendary-node-button：平台不提供独立传说入口，记一次跳过，不算失败
        const noEntry = /^LEGENDARY_ENTRY_(MISSING|UNMATCHED|SCROLL_LIMIT|SECTION_UNREACHABLE)\b/.exec(error.message);
        if (noEntry) {
          skipped.add(slot.id);
          // 只有真实看到气泡渲染且缺入口（MISSING）才算 observed-absent；
          // UNMATCHED / SCROLL_LIMIT / SECTION_UNREACHABLE 是没找到/没滚到/老段进不去，保留 unknown/unreachable
          if (/^LEGENDARY_ENTRY_MISSING\b/.test(error.message)) entryEvidence.set(slot.id, 'observed-absent');
          console.log('LEGENDARY_NO_ENTRY id=' + slot.id + ' type=' + slot.type + ' ' + error.message.replace(/^LEGENDARY_ENTRY_\w+\s*/, ''));
          active = null;
          progress = await readProgress().catch(() => progress);
          await page.goto(ORIGIN + '/learn', { timeout: 45000 }).catch(() => {});
          await page.waitForTimeout(1500);
          continue;
        }
        // 传奇入口消失说明这关已经不是"passed 未传奇"（多半结算了但进度没读出来），本次运行别再重试
        if (/没有有效的传奇入口/.test(error.message)) {
          skipped.add(slot.id);
          console.log('SKIP_SLOT id=' + slot.id + ' 传奇入口不存在，本次运行不再重试');
          active = null;
          progress = await readProgress().catch(() => progress);
          await page.goto(ORIGIN + '/learn', { timeout: 45000 }).catch(() => {});
          await page.waitForTimeout(2000);
          continue;
        }
        const fail = retry.fail(lessonSlot.id);
        console.log('NODE_FAIL id=' + slot.id + ' attempts=' + fail.attempts + ' streak=' + fail.streak + ' ' + error.message.slice(0, 100));
        if (fail.action === 'skip-node') {
          console.log('SKIP_NODE id=' + slot.id + ' 同一节点失败 ' + fail.attempts + ' 次，换下一个可达节点');
        }
        if (fail.stop === 'node-streak') throw new Error('连续 ' + fail.streak + ' 个不同节点失败，停止（最后：' + slot.id + '）');
        if (fail.stop === 'total-attempts') throw new Error('总尝试 ' + fail.totalAttempts + ' 次失败，停止（最后：' + slot.id + '）');
        active = null;
        progress = await readProgress().catch(() => progress);
        await page.goto(ORIGIN + '/learn', { timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    }
    logChains(progress.course);
    console.log('STOP max-lessons xpGain=' + (progress.xp - startXp));
  } catch (error) {
    await page.screenshot({ path: path.join(__dirname, 'auto-blocked.png'), timeout: 3000 }).catch(() => {});
    throw error;
  } finally {
    if (keepOpen) {
      console.log('KEEP_OPEN 专用窗口和当前页面已保留；处理完关闭窗口即可');
    } else {
      await ctx.close();
    }
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('BLOCKED ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = { solve, prepareDeferredRadio, prepareByStoryNode, storyUiSig, finishStory };
