const ORIGIN = 'https://www.duolingo.com';
const LEARN = /^https:\/\/www\.duolingo\.com\/learn(?:[/?#]|$)/;

function parseLegendaryEntry(href) {
  if (!href) throw new Error('传奇确认层没有入口链接');
  const url = new URL(href, ORIGIN);
  if (url.origin !== ORIGIN || !/^\/lesson\/unit\/[1-9]\d*\/legendary\/[1-9]\d*\/?$/.test(url.pathname)) {
    throw new Error('目标节点没有有效的传奇入口');
  }
  return url;
}

// URL 层号 = 路径索引 + 1（u23l0→unit/24/legendary/1、u23l2→unit/24/legendary/3，已验证多次）。
// 直接构造省掉路径节点定位：/learn 只渲染当前一小段，节点还可能被课程切换搞错。
async function prepareByUrl(page, slot, check) {
  const guess = ORIGIN + '/lesson/unit/' + (slot.unitIndex + 1) + '/legendary/' + (slot.levelIndex + 1);
  await check();
  await page.goto(guess, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3500);
  const button = page.locator('[data-test="legendary-start-button"]:visible').first();
  if (!(await button.count())) {
    // 有些节点不走确认页，直接进了课程；URL 已经在目标上就不算失败
    const u = new URL(page.url());
    if (u.origin === ORIGIN && /^\/lesson\/unit\/\d+\/legendary\/\d+/.test(u.pathname)) {
      return { button: null, url: u };
    }
    throw new Error('目标节点没有有效的传奇入口');
  }
  let url;
  try { url = parseLegendaryEntry(await button.getAttribute('href')); }
  catch (e) { const u = new URL(page.url()); url = u.origin === ORIGIN ? u : new URL(guess); }
  return { button, url };
}

// /learn 是虚拟列表：目标 unit 可能在远处没渲染。先回顶部，再逐屏向下滚到目标 unit；
// 上限 120 屏 / 90 秒，超限返回 {ok:false}（上层记 SCROLL_LIMIT/unknown，不当 absent）。
// 滚动过程记录「已滚屏数 / 当前渲染到的 unit 索引」，用于区分「滚不到」与「不在当前段」。
// 更正（2026-11-19）：早先「/learn 不渲染老段」是 900px 大步长 + 400ms 检查太快的误判；
// 300px/200ms 小步长下 unit 69→128 连续渲染，老段（unit<当前段起点）走 /sections 阶段入口即可。
async function renderedUnitIndexes(page) {
  return await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-test*="skill-path-unit-"]')) {
      const m = /skill-path-unit-(\d+)/.exec(el.getAttribute('data-test') || '');
      if (m) out.push(Number(m[1]));
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }).catch(() => []);
}

async function ensureUnitVisible(page, unit, { maxScreens = 120, maxMs = 90000 } = {}) {
  const started = Date.now();
  const check = async () => {
    const c = await unit.count().catch(() => 0);
    if (!c) return false;
    return await unit.first().isVisible().catch(() => false);
  };
  // 两段式：先回顶部（unit 30 距当前约 40 个单元，从当前位置向上滚不够）
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.keyboard.press('Home').catch(() => {});
  await page.waitForTimeout(800);
  // 冷启动时 /learn 可能还没渲染出任何 unit：先等首帧，等不到就快速失败让上层重试，
  // 不要对着空页面空滚 120 屏（2026-11-20 section 3 首批就这么白耗过）。
  let firstPaint = await renderedUnitIndexes(page);
  for (let w = 0; w < 10 && !firstPaint.length; w++) {
    await page.waitForTimeout(1000);
    firstPaint = await renderedUnitIndexes(page);
  }
  if (!firstPaint.length) return { ok: false, screens: 0, stats: [], reason: 'no-render' };
  await page.mouse.move(640, 450).catch(() => {});
  const stats = [];
  for (let i = 0; i < maxScreens; i++) {
    const seen = await renderedUnitIndexes(page);
    stats.push({ screen: i, seen });
    if (await check()) return { ok: true, screens: i, stats };
    if (Date.now() - started > maxMs) return { ok: false, screens: i, stats, reason: 'time' };
    await page.mouse.wheel(0, 900).catch(() => {});
    await page.waitForTimeout(500);
  }
  return { ok: false, screens: maxScreens, stats, reason: 'screens' };
}

// /learn 只渲染「当前段」；老段（unit 30/31 等）在页面上有平台自己的入口：
// /sections → 第 N 阶段「复习」→ /learn 渲染该阶段路径（2026-11-19 实测 unit 28–31，
// 且 unit 31 skill 节点气泡里真实出现 legendary-node-button）。这是页面按钮，不是构造 lesson URL。
// 但它是客户端瞬时状态：刷新或重新 goto /learn 就回当前段，所以每次都要重新点。
// 「复习」按钮是客户端渲染：真机里偶发 6 秒还没出现，轮询最多 15 秒，不秒判没入口
async function waitReviewButtons(page, tries = 15) {
  for (let i = 0; i < tries; i++) {
    const c = await page.locator('button', { hasText: '复习' }).count().catch(() => 0);
    if (c) return c;
    await page.waitForTimeout(1000);
  }
  return 0;
}

async function sectionDiag(page) {
  return await page.evaluate(() => ({
    url: location.pathname,
    texts: [...document.querySelectorAll('button')].map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 10),
  })).catch(() => ({ url: '?', texts: [] }));
}

// 节点离视口顶部太近时，点击会被固定导航栏拦截：返回需要滚动的像素（向上让出空间）
function nodeClickOffset(box, clearance = 160, minY = 120) {
  if (!box || typeof box.y !== 'number') return 0;
  if (box.y >= minY) return 0;
  return box.y - clearance;
}

// 该不该走 /sections 阶段入口：只有「目标阶段早于当前渲染阶段」才走。
// 同段（靠前或靠后）与更晚阶段一律走滚动——2026-11-20 section 3 的 unit 69/70
// 曾被「小于最小渲染 unit」误判成老段，导致 SECTION_JUMP_UNMATCHED。
// 当前阶段未知（页面还没渲染出标题）时也走滚动，不猜。
function shouldJumpToSection(targetSection, currentSection) {
  if (!Number.isInteger(targetSection) || !Number.isInteger(currentSection)) return false;
  return targetSection < currentSection;
}

// 当前 /learn 路径属哪个阶段：页面标题「第 N 阶段，第 X 部分」（N 从 1 起）
async function currentPathStage(page) {
  return await page.evaluate(() => {
    const norm = (x) => (x || '').replace(/\s+/g, ' ').trim();
    const m = /第 (\d+) 阶段，第 (\d+) 部分/.exec(norm(document.body.innerText));
    return m ? { stage: Number(m[1]), part: Number(m[2]) } : null;
  }).catch(() => null);
}

async function openOldSectionPath(page, sectionIndex, unitIndex, { waitMs = 10000, check = null } = {}) {
  await page.goto(ORIGIN + '/sections', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const count = await waitReviewButtons(page);
  if (!count) {
    const diag = await sectionDiag(page);
    return { ok: false, tab: -1, rendered: [], reason: 'NO_REVIEW_ENTRY', diag };
  }
  // 第 N 阶段 = 第 N 个「复习」：先按阶段序号点，没到目标再按顺序兜底（有上限，不无限试）
  const tries = [sectionIndex, ...Array.from({ length: count }, (_, i) => i).filter((i) => i !== sectionIndex)]
    .filter((i) => i >= 0 && i < count)
    .slice(0, 4);
  let rendered = [];
  let lastStage = null;
  for (const tab of tries) {
    if (check) await check();
    await page.goto(ORIGIN + '/sections', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(4000);
    if (!(await waitReviewButtons(page))) break;
    await page.locator('button', { hasText: '复习' }).nth(tab).click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(waitMs);
    rendered = await renderedUnitIndexes(page);
    lastStage = await currentPathStage(page);
    // 目标 unit 不一定已经在虚拟列表里（段首只渲染邻近几屏），
    // 所以「页面标题已经是目标阶段」就算跳对，交给后面的滚动定位去找节点。
    if (rendered.includes(unitIndex)) return { ok: true, tab, rendered, stage: lastStage };
    if (lastStage && lastStage.stage === sectionIndex + 1) return { ok: true, tab, rendered, stage: lastStage, viaStage: true };
  }
  return { ok: false, tab: -1, rendered, stage: lastStage, reason: 'SECTION_JUMP_UNMATCHED' };
}

// 传说入口只认 /learn 节点气泡里真实出现的 legendary-node-button
//（s3u72l1 实测文本「晋升传奇 +40 经验」），不构造 URL 当入口证明。
async function prepareByNode(page, slot, check) {
  await check();
  await page.goto(ORIGIN + '/learn', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  // /learn 客户端渲染：早先 3 秒时节点/气泡还没就绪，等 8 秒再定位
  await page.waitForTimeout(8000);
  let unit = page.locator('[data-test~="skill-path-unit-' + slot.unitIndex + '"]').first();
  // 目标 unit 不在当前渲染视图里时：只有「目标阶段早于当前阶段」才走 /sections 阶段入口，
  // 同段/更晚段一律走滚动（section 3 的 unit 69/70 曾被旧判断误跳）。
  if (!(await unit.count().catch(() => 0))) {
    const stage = await currentPathStage(page).catch(() => null);
    const currentSection = stage ? stage.stage - 1 : null;
    console.log('LEGENDARY_ENTRY_SEGMENT targetUnit=' + slot.unitIndex + ' targetSection=' + slot.sectionIndex
      + ' currentSection=' + currentSection + ' jump=' + shouldJumpToSection(slot.sectionIndex, currentSection));
    if (shouldJumpToSection(slot.sectionIndex, currentSection)) {
      const jump = await openOldSectionPath(page, slot.sectionIndex, slot.unitIndex, { check }).catch(() => ({ ok: false, rendered: [] }));
      console.log('LEGENDARY_ENTRY_SECTION_JUMP section=' + slot.sectionIndex + ' unit=' + slot.unitIndex
        + ' ok=' + jump.ok + ' tab=' + jump.tab + ' rendered=' + JSON.stringify(jump.rendered).slice(0, 120)
        + (jump.reason ? ' reason=' + jump.reason : '')
        + (jump.diag ? ' diag=' + JSON.stringify(jump.diag).slice(0, 160) : ''));
      if (!jump.ok) {
        // 目标阶段更早却进不去：直说不可达（unknown），不去滚 120 屏空耗。
        throw new Error('LEGENDARY_ENTRY_SECTION_UNREACHABLE id=' + slot.id + ' unit=' + slot.unitIndex
          + ' section=' + slot.sectionIndex + ' rendered=' + JSON.stringify(jump.rendered).slice(0, 120)
          + ' reason=' + (jump.reason || 'SECTION_JUMP_UNMATCHED'));
      } else {
        unit = page.locator('[data-test~="skill-path-unit-' + slot.unitIndex + '"]').first();
      }
    }
  }
  const pos = await ensureUnitVisible(page, unit).catch(() => ({ ok: false, screens: 0, stats: [] }));
  if (!pos.ok && pos.reason === 'no-render') {
    throw new Error('LEGENDARY_ENTRY_NO_RENDER id=' + slot.id + ' unit=' + slot.unitIndex);
  }
  if (!pos.ok) {
    const last = pos.stats && pos.stats.length ? pos.stats[pos.stats.length - 1].seen : [];
    throw new Error('LEGENDARY_ENTRY_SCROLL_LIMIT id=' + slot.id + ' unit=' + slot.unitIndex
      + ' screens=' + (pos.screens || 0) + ' rendered=' + JSON.stringify(last).slice(0, 120));
  }
  await unit.scrollIntoViewIfNeeded({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(800);
  const node = unit.locator('[data-test~="skill-path-level-' + slot.levelIndex + '"]').first();
  // 节点在虚拟列表里也可能晚一拍渲染：再滚一次并等一会，最多 3 次，别一次取样就判 UNMATCHED
  let nodeCount = await node.count().catch(() => 0);
  for (let i = 0; i < 2 && !nodeCount; i++) {
    await unit.scrollIntoViewIfNeeded({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(1200);
    nodeCount = await node.count().catch(() => 0);
  }
  if (!nodeCount) throw new Error('LEGENDARY_ENTRY_UNMATCHED id=' + slot.id);
  // 节点可能落在视口上方/下方：先滚到可见再点，避免点到被裁剪的位置
  await node.scrollIntoViewIfNeeded({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(800);
  // 顶部导航栏会吃掉落在它下面的点击（2026-11-20 unit 40 level-0：节点 y≈24，点不开气泡）：
  // 节点离顶部太近时先向上让出 160px，再点。
  const box = await node.boundingBox().catch(() => null);
  const dy = nodeClickOffset(box);
  if (dy) {
    await page.evaluate((d) => window.scrollBy(0, d), dy).catch(() => {});
    await page.waitForTimeout(600);
  }
  await node.click({ timeout: 6000 }).catch(() => {});
  // 气泡/传说按钮是客户端渲染：真机里 5-10 秒才出现，轮询等它，不按固定 2.5 秒下结论
  const btn = page.locator('[data-test="legendary-node-button"]:visible');
  let n = 0;
  for (let w = 0; w < 12; w++) {
    await page.waitForTimeout(1000);
    n = await btn.count().catch(() => 0);
    if (n) break;
  }
  if (n !== 1) {
    // MISSING 只在「节点找到、气泡已渲染、确认缺传说入口」时成立；气泡没渲染（虚拟滚动）
    // 只能算 UNMATCHED，保留 unknown，不等于平台不提供传说。
    const bubbleLinks = await page.locator('[data-test*="skill-path-state"]:visible').count().catch(() => 0);
    const kind = n > 1 ? 'AMBIGUOUS' : (bubbleLinks > 0 ? 'MISSING' : 'UNMATCHED');
    throw new Error('LEGENDARY_ENTRY_' + kind + ' id=' + slot.id + ' type=' + slot.type + ' candidates=' + n + ' bubbleLinks=' + bubbleLinks);
  }
  const label = String(await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  await check();
  await btn.click({ timeout: 5000 });
  // 点完可能直接进传说课、弹确认层（legendary-start-button 或 player-next「继续」）或跳 URL
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    if (!/\/legendary\//.test(new URL(page.url()).pathname)) {
      const start0 = page.locator('[data-test="legendary-start-button"]:visible');
      if (await start0.count().catch(() => 0) === 1) {
        await start0.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(2000);
      } else {
        const cont = page.locator('[data-test="player-next"]:visible');
        if (await cont.count().catch(() => 0) === 1 && await cont.isEnabled().catch(() => false)) {
          await cont.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(2000);
        }
      }
      if (!/\/legendary\//.test(new URL(page.url()).pathname)) continue;
    }
    const start = page.locator('[data-test="legendary-start-button"]:visible');
    if (await start.count().catch(() => 0) === 1) {
      await start.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }
    const next = page.locator('[data-test="player-next"]:visible');
    if (await next.count().catch(() => 0) === 1 && await next.isEnabled().catch(() => false)) {
      await next.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }
    return { button: null, url: new URL(page.url()), entryLabel: label };
  }
  throw new Error('LEGENDARY_ENTRY_NO_LESSON id=' + slot.id + ' url=' + new URL(page.url()).pathname);
}

function findCourseLevel(course, slot) {
  if (course.id !== slot.courseId) return null;
  const section = course.pathSectioned.find(value => value.index === slot.sectionIndex);
  const unit = section?.units.find(value => value.unitIndex === slot.unitIndex);
  return unit?.levels.find(level => level.id === slot.id) ?? null;
}

module.exports = { prepareByUrl, prepareByNode, ensureUnitVisible, openOldSectionPath, shouldJumpToSection, currentPathStage, nodeClickOffset, parseLegendaryEntry, findCourseLevel, LEARN, ORIGIN };
