const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const policy = require('./automation-policy.js');
const core = require('./core.js');
const storyRunner = require('./story-runner.js');
const lessonRunner = require('./lesson-runner.js');
const { prepareByUrl, prepareLegendary, findCourseLevel, LEARN, ORIGIN } = require('./legendary-entry.js');

const nextSelector = '[data-test="player-next"]:visible';

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
  let stalled = 0;
  let feedbackSince = null;
  let storyFinished = false;
  let nodom = 0;
  let nomatchLogged = false;
  for (let round = 0; round < 400; round++) {
    await check();
    if (LEARN.test(page.url())) return answered;

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
        const result = await lessonRunner.step(page, target.data, check);
        if (result.status === 'waiting') {
          feedbackSince ??= Date.now();
          if (Date.now() - feedbackSince > 30000) throw new Error('等待普通课反馈或结算超时');
        } else {
          feedbackSince = null;
        }
        if (['answered', 'skipped', 'advanced'].includes(result.status)) {
          if (result.status === 'answered') answered++;
          console.log('LESSON_' + result.status.toUpperCase() + (result.type ? ' type=' + result.type : ''));
          stalled = 0;
        } else if (result.status !== 'waiting' && ++stalled >= 20) {
          throw new Error('普通题停滞 ' + result.status + ' ' + (result.kind || '-') + ' ' + dom.type + ' ' + dom.boxText.slice(0, 120));
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

async function main() {
  const minutes = numberArg('minutes', 0.001);
  const xp = numberArg('xp', 1);
  const fromSection = numberArg('from-section', 0) ?? 0;
  const fromUnit = numberArg('from-unit', 0) ?? 0;
  const maxLessons = numberArg('max-lessons', 1) ?? Infinity;
  if (!minutes && !xp) throw new Error('必须给 --minutes 或 --xp 上限');

  const startedAt = Date.now();
  // 本次运行内确定进不去的节点（传奇入口已消失），不再重试
  const skipped = new Set();
  const select = course => policy.planCourse(course).candidates.filter(slot =>
    !skipped.has(slot.id) && slot.sectionIndex >= fromSection && slot.unitIndex >= fromUnit);
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
    const document = onSite && response.request().resourceType() === 'document';
    if ((story || user || session || document) && [401, 403, 429].includes(response.status())) {
      restriction ||= '关键请求 HTTP ' + response.status() + ' ' + url.pathname;
      return;
    }
    const target = active;
    if ((!user && !session && !story) || !response.ok()) return;
    try {
      const data = await response.json();
      if (user && data.currentCourse?.pathSectioned && Number.isFinite(data.totalXp)) {
        uid = user[1];
        initialProgress ||= { course: data.currentCourse, xp: data.totalXp };
      }
      if (session && Array.isArray(data.challenges)) {
        console.log('SESSION_SEEN type=' + data.type + ' n=' + data.challenges.length
          + ' skillId=' + (data.skillId || '-') + ' levelIndex=' + (data.levelIndex ?? '-'));
      }
      if (!target || target !== active || target.data) return;
      if (target.slot.type === 'story' && story && Array.isArray(data.elements)
          && decodeURIComponent(url.pathname.split('/').at(-1)) === target.level.pathLevelMetadata?.storyId) {
        target.data = data;
        console.log('STORY_DATA elements=' + data.elements.length);
      }
      if (target.slot.type !== 'story' && session && Array.isArray(data.challenges)
          && /^LEGENDARY/.test(data.type || '') && data.id && !seenSessions.has(data.id)) {
        const meta = target.level.pathLevelMetadata || {};
        let matched;
        if (target.slot.type === 'skill') {
          matched = data.skillId === meta.skillId && data.levelIndex === meta.crownLevelIndex;
        } else {
          // 复习/单元复习的 session 是 LEGENDARY_LEXEME_PRACTICE，里面没有 skillId/levelIndex 可对，
          // 既然页面已经导航到这节的 URL，就认这个 session
          matched = true;
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
      active = { slot, level, data: null };
      try {
      const entry = await prepareByUrl(page, slot, check);
      console.log('ENTRY s' + slot.sectionIndex + 'u' + slot.unitIndex + 'l' + slot.levelIndex + ' ' + slot.name + ' → ' + entry.url.pathname);
      if (!budget().mayStartNext) {
        console.log('STOP ' + JSON.stringify(budget()));
        return;
      }
      await check();
      active.startedAt = Date.now();
      if (entry.button) {
        await clickSafe(page, entry.button, 4);
        await page.waitForURL(url => url.origin === ORIGIN && url.pathname === entry.url.pathname, { timeout: 25000 });
      }
      const answered = await solve(page, active, check);

      const before = progress.xp;
      for (let attempt = 0; attempt < 3; attempt++) {
        progress = await readProgress();
        if (findCourseLevel(progress.course, slot)?.state === 'legendary' && progress.xp > before) break;
        if (attempt < 2) await page.waitForTimeout(1200);
      }
      const state = findCourseLevel(progress.course, slot)?.state;
      if (state !== 'legendary' || progress.xp <= before) {
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
