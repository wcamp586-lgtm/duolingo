const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const policy = require('./automation-policy.js');
const core = require('./core.js');
const storyRunner = require('./story-runner.js');
const lessonRunner = require('./lesson-runner.js');
const { prepareByUrl, prepareLegendary, findCourseLevel, LEARN, ORIGIN } = require('./legendary-entry.js');

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
  let feedbackSince = null;
  let storyFinished = false;
  let nodom = 0;
  let nomatchLogged = false;
  for (let round = 0; round < 400; round++) {
    await check();
    if (LEARN.test(page.url())) return answered;
    // 普通课：这关的题答完（含跳过）就退出，别在"继续练习"页里死循环
    const total = Array.isArray(target.data?.challenges) ? target.data.challenges.length : 0;
    if (target.mode === 'normal' && total && answered + skippedCount >= total) return answered;

    if (target.slot.type === 'story') {
      const finish = page.locator('[data-test="stories-player-done"]:visible');
      const cover = page.locator('[data-test="story-start"]:visible');
      const lastNext = page.locator('[data-test="stories-player-continue"]:visible');
      if (await finish.count()) {
        await check();
        await clickSafe(page, finish);
        await page.waitForURL(LEARN, { timeout: 45000 });
        return answered;
      }
      if (await cover.count() && target.data) {
        await check();
        await clickSafe(page, cover);
      } else if (storyFinished && await lastNext.count() && await lastNext.isEnabled()) {
        await check();
        await clickSafe(page, lastNext);
        // 完成信号有两种：出现 stories-player-done，或者直接回到学习路径
        await Promise.race([
          finish.waitFor({ timeout: 45000 }).catch(() => {}),
          page.waitForURL(LEARN, { timeout: 45000 }).catch(() => {}),
        ]);
      } else if (target.data) {
        const result = await storyRunner.step(page, target.data, check);
        if (result.status === 'blocked') throw new Error(result.error);
        if (result.status === 'answered') answered++;
        if (result.status === 'done') storyFinished = true;
      }
    } else {
      const dom = await lessonRunner.readDom(page);
      if (dom && target.data) {
        const result = await lessonRunner.step(page, target.data, check, lexemes);
        if (result.status === 'waiting') {
          feedbackSince ??= Date.now();
          if (Date.now() - feedbackSince > 30000) throw new Error('等待普通课反馈或结算超时');
        } else {
          feedbackSince = null;
        }
        if (['answered', 'skipped', 'advanced'].includes(result.status)) {
          if (result.status === 'answered') answered++;
          if (result.status === 'skipped') skippedCount++;
          console.log('LESSON_' + result.status.toUpperCase() + (result.type ? ' type=' + result.type : ''));
          stalled = 0;
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
        } else if (result.status !== 'waiting' && ++stalled >= 20) {
          throw new Error('普通题停滞 ' + result.status + ' ' + (result.kind || '-') + ' ' + dom.type + ' ' + dom.boxText.slice(0, 120));
        }
      } else if (!dom) {
        // 整页加载中：这不是停滞，等它加载完，别去点 next
        if (await page.locator('[data-test="loading-screen"]').count().catch(() => 0)) {
          if (nodom % 5 === 0) console.log('LESSON_LOADING');
          nodom++;
          await page.waitForTimeout(2000);
          continue;
        }
        // 普通课的完成页按钮，名字和故事课不一样
        const endBtn = page.locator('[data-test="legendary-session-end-continue"]:visible');
        if (await endBtn.count().catch(() => 0)) {
          await clickSafe(page, endBtn);
          console.log('LESSON_END');
          await page.waitForTimeout(1500);
          continue;
        }
        const next = page.locator(nextSelector);
        if (await next.count() && await next.isEnabled()) {
          await check();
          await clickSafe(page, next);
          nodom++;
          console.log('LESSON_CONTINUE #' + nodom);
          // 连续多次推进都没进展，说明卡在结算，把现场打出来
          if (nodom % 5 === 0) {
            const dump = await page.evaluate(() => ({
              url: location.pathname,
              tests: [...new Set([...document.querySelectorAll('[data-test]')].map((e) => e.getAttribute('data-test')))].slice(0, 12),
              text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
            })).catch(() => null);
            console.log('LESSON_NODOM ' + JSON.stringify(dump));
          }
          await page.waitForTimeout(1200);
          continue;
        }
        // 没有题目容器、也没有可点的 next：结算动画或完成页
        nodom++;
        if (nodom % 3 === 0) {
          const dump = await page.evaluate(() => ({
            url: location.pathname + location.search,
            tests: [...new Set([...document.querySelectorAll('[data-test]')].map((e) => e.getAttribute('data-test')))].slice(0, 14),
            buttons: [...document.querySelectorAll('button')]
              .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
              .map((e) => (e.innerText || '').trim().slice(0, 16)).filter(Boolean).slice(0, 8),
            text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
          })).catch(() => null);
          console.log('LESSON_IDLE ' + JSON.stringify(dump));
        }
        await page.waitForTimeout(1000);
        continue;
      }
    }
    await page.waitForTimeout(550);
    if (!target.data && Date.now() - target.startedAt > 45000) {
      throw new Error('未收到与目标节点匹配的课程数据');
    }
  }
  throw new Error('课程未在步数上限内回到学习路径');
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

// 普通课入口：/lesson 直接进当前 active 节点（不能像传奇那样构造 unit/level URL，那个 404）
// 延后 radio：路径上点它 → 「稍后选择」 → 同一 unit 往后找第一个有「开始」入口的节点并进课。
// 接口会把 radio 报 active、下一节点 locked，但网页上下一节点已有可点的开始（Codex 实测）。
async function prepareDeferredRadio(page, check, slot) {
  await check();
  await page.goto(ORIGIN + '/learn', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  // 学习路径是客户端渲染的，法语课常见要 7-9 秒才出现；3 秒时 unit 还不存在
  const unit = page.locator('[data-test="skill-path-unit-' + slot.unitIndex + '"]').first();
  await unit.waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await unit.scrollIntoViewIfNeeded({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(800);
  const radio = unit.locator('[data-test="skill-path-level-' + slot.levelIndex + ' skill-path-level-duo_radio"]').first();
  // 用 locator 点击而不是坐标：坐标会被已经展开的气泡挡住
  await radio.click({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const later = page.locator('button:has-text("稍后选择"), [role="button"]:has-text("稍后选择")').filter({ visible: true }).first();
  if (await later.count()) {
    await later.click({ timeout: 5000 }).catch(() => {});
    console.log('RADIO_LATER 点了稍后选择');
    await page.waitForTimeout(2500);
  } else {
    // 按钮是一次性的（用过就不再出现）：再点一次节点把气泡关掉，否则会挡住下一节点
    await radio.click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  for (let li = slot.levelIndex + 1; li <= slot.levelIndex + 4; li++) {
    const node = unit.locator('[data-test^="skill-path-level-' + li + ' "]').first();
    if (!(await node.count())) continue;
    await node.click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(2000);
    // 入口是 <a data-test="skill-path-state-active ...">开始 +10 经验</a>，不是按钮
    const start = page.locator('a[data-test*="skill-path-state-active"]').filter({ hasText: '开始' }).filter({ visible: true }).first();
    if (await start.count()) {
      await start.click({ timeout: 5000 }).catch(() => {});
      console.log('RADIO_NEXT level=' + li + ' 点了开始');
      await page.waitForTimeout(4000);
      return { url: new URL(page.url()), deferred: true };
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  }
  throw new Error('延后 radio 后没有找到下一节点的开始入口');
}

async function prepareNormal(page, check, slot) {
  await check();
  if (slot && slot.type === 'duo_radio') return await prepareDeferredRadio(page, check, slot);
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
  const select = course => (mode === 'normal' ? policy.planNormal(course) : policy.planCourse(course).candidates).filter(slot =>
    !skipped.has(slot.id) && slot.sectionIndex >= fromSection && slot.unitIndex >= fromUnit
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
  let uid;
  let active;
  let restriction;
  let initialProgress;
  const seenSessions = new Set();

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
      if (target.slot.type === 'story' && story && Array.isArray(data.elements)
          && decodeURIComponent(url.pathname.split('/').at(-1)) === target.level.pathLevelMetadata?.storyId) {
        target.data = data;
        console.log('STORY_DATA elements=' + data.elements.length);
      }
      if (target.slot.type !== 'story' && session && Array.isArray(data.challenges) && data.id && !seenSessions.has(data.id)) {
        const meta = target.level.pathLevelMetadata || {};
        let matched;
        if (mode === 'normal') {
          if (target.slot.type === 'skill' || target.slot.type === 'story') {
            // 普通课：LESSON/LEVEL_REVIEW，按当前 active 节点的 skillId/crownLevelIndex 认
            matched = /^(LESSON|LEVEL_REVIEW)/.test(data.type || '') && data.skillId === meta.skillId && data.levelIndex === meta.crownLevelIndex;
          } else {
            // 练习/单元复习：LEXEME_PRACTICE，没有 skillId/levelIndex 可对，页面进了 /lesson 就认
            matched = /^(LEXEME_PRACTICE|UNIT_PRACTICE|LESSON|LEVEL_REVIEW)/.test(data.type || '');
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

  const readProgress = async () => {
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
    return result;
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
    let slotFails = 0;
    for (let completed = 0; completed < maxLessons;) {
      if (!budget().mayStartNext) {
        console.log('STOP ' + JSON.stringify(budget()));
        return;
      }
      if (progress.course.id !== courseId) throw new Error('当前课程已切换');
      const slot = select(progress.course)[0];
      if (!slot) {
        console.log('STOP 没有待做节点');
        return;
      }
      const level = findCourseLevel(progress.course, slot);
      active = { slot, level, data: null, mode };
      // 普通课/传奇课都先看预加载缓存：/lesson 有时根本不发新 session（页面直接用预加载那份）
      const meta = level?.pathLevelMetadata || {};
      const cached = sessionCache.get((meta.skillId || '') + '|' + (meta.crownLevelIndex ?? ''));
      if (cached && !seenSessions.has(cached.id)
          && (mode === 'normal' ? /^(LESSON|LEVEL_REVIEW)/.test(cached.type || '') : /^LEGENDARY/.test(cached.type || ''))) {
        active.data = cached;
        seenSessions.add(cached.id);
        console.log('SESSION_CACHED type=' + cached.type + ' n=' + cached.challenges.length);
      }
      try {
      const entry = mode === 'normal' ? await prepareNormal(page, check, slot) : await prepareByUrl(page, slot, check);
      console.log('ENTRY s' + slot.sectionIndex + 'u' + slot.unitIndex + 'l' + slot.levelIndex + ' ' + slot.name + ' → ' + entry.url.pathname + (entry.chest ? ' (chest)' : ''));
      if (!budget().mayStartNext) {
        console.log('STOP ' + JSON.stringify(budget()));
        return;
      }
      await check();
      active.startedAt = Date.now();
      let answered = 0;
      if (!entry.chest) {
        if (entry.deferred) {
          await page.waitForTimeout(2000);
        } else if (entry.button) {
          await clickSafe(page, entry.button, 4);
          await page.waitForURL(url => url.origin === ORIGIN && url.pathname === entry.url.pathname, { timeout: 25000 });
        }
        answered = await solve(page, active, check);
      }

      const before = progress.xp;
      const wantState = mode === 'normal' ? 'passed' : 'legendary';
      for (let attempt = 0; attempt < 3; attempt++) {
        progress = await readProgress();
        const levelState = findCourseLevel(progress.course, slot)?.state;
        if (progress.xp > before && (mode === 'normal' || levelState === wantState)) break;
        if (attempt < 2) await page.waitForTimeout(1200);
      }
      const state = findCourseLevel(progress.course, slot)?.state;
      // 普通课一个 skill 节点要多次会话才 passed（totalSessions 常见 4），单节成功以 XP 到账为准；
      // 宝箱打开不给 XP，只有 state 从 active 变 passed，所以 state 变化也算结算
      if (mode === 'normal') {
        if (progress.xp <= before && state === 'active') {
          throw new Error('未确认目标结算 id=' + slot.id + ' state=' + state + ' XP变化=' + (progress.xp - before));
        }
      } else if (progress.xp <= before || state !== wantState) {
        throw new Error('未确认目标结算 id=' + slot.id + ' state=' + state + ' XP变化=' + (progress.xp - before));
      }
      completed++;
      slotFails = 0;
      active = null;
      console.log('SETTLED id=' + slot.id + ' state=' + state + ' xp=' + progress.xp + ' delta=' + (progress.xp - before) + ' answered=' + answered);
      } catch (error) {
        // 平台限制/验证一律终止；单关故障（超时、确认不到结算）只跳过这一关
        if (/restriction|验证|reCAPTCHA|\b(401|403|429)\b|登录/.test(error.message)) throw error;
        // 浏览器被关掉（手动关窗或崩溃）就没法继续了，干净退出而不是当单关故障重试
        if (/has been closed|Target page|Browser has been closed/i.test(error.message) || page.isClosed()) {
          console.log('BROWSER_CLOSED 停止（浏览器已关闭）');
          return;
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
        slotFails++;
        console.log('SKIP_SLOT id=' + slot.id + ' (' + slotFails + '/8) ' + error.message.slice(0, 100));
        active = null;
        if (slotFails >= 8) throw new Error('连续 8 关失败，停止（最后一关：' + error.message.slice(0, 80) + '）');
        progress = await readProgress().catch(() => progress);
        await page.goto(ORIGIN + '/learn', { timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    }
    console.log('STOP max-lessons xpGain=' + (progress.xp - startXp));
  } catch (error) {
    await page.screenshot({ path: path.join(__dirname, 'auto-blocked.png'), timeout: 3000 }).catch(() => {});
    throw error;
  } finally {
    await ctx.close();
  }
}

main().catch(error => {
  console.error('BLOCKED ' + error.message);
  process.exitCode = 1;
});
