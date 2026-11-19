// 离线验证 /learn 虚拟列表滚动定位：先从底部回顶部，再逐屏向下滚到目标 unit；
// 上限 120 屏/90 秒，超限返回 ok:false（上层记 SCROLL_LIMIT/unknown，不当 absent）。
// 不联网、不使用 profile/；只 mock page 与 unit locator。
const assert = require('node:assert/strict');
const { ensureUnitVisible, openOldSectionPath, isOldSegment, shouldTrySectionJump } = require('./legendary-entry.js');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' -> ' + e.message); }
};

function mockPage({ appearAfter = 3, units = [] } = {}) {
  let wheels = 0;
  const unit = {
    async count() { return wheels >= appearAfter ? 1 : 0; },
    first() { return { isVisible: async () => wheels >= appearAfter }; },
  };
  const page = {
    mouse: { move: async () => {}, wheel: async () => { wheels++; } },
    keyboard: { press: async () => {} },
    async evaluate() { return units; },
    async waitForTimeout() {},
  };
  return { page, unit, wheels: () => wheels };
}

(async () => {
  console.log('legendary-scroll');

  await t('回顶部后逐屏向下滚，找到远处 unit（记录屏数与渲染到的 unit）', async () => {
    const { page, unit, wheels } = mockPage({ appearAfter: 3, units: [70, 71, 72] });
    const pos = await ensureUnitVisible(page, unit);
    assert.equal(pos.ok, true);
    assert.equal(pos.screens, 3);
    assert.ok(wheels() >= 3, '应滚动到目标出现，实际 ' + wheels());
    assert.ok(Array.isArray(pos.stats[0].seen), '应记录当前渲染到的 unit 索引');
  });

  await t('目标 unit 一直不渲染：到 120 屏上限返回 false（不无限滚）', async () => {
    const { page, unit, wheels } = mockPage({ appearAfter: 999 });
    const pos = await ensureUnitVisible(page, unit);
    assert.equal(pos.ok, false);
    assert.equal(pos.screens, 120, '上限 120 屏');
    assert.equal(wheels(), 120);
  });

  await t('上限可配置：maxScreens=3 时第 4 屏才出现也算失败', async () => {
    const { page, unit } = mockPage({ appearAfter: 4 });
    const pos = await ensureUnitVisible(page, unit, { maxScreens: 3 });
    assert.equal(pos.ok, false);
  });

  // 老段（/learn 只渲染当前段）：走平台自己的 /sections → 第 N 阶段「复习」→ /learn 渲染该阶段
  const mockSectionPage = ({ reviews = 3, unitsByTab = {} } = {}) => {
    let clicked = -1;
    const clicks = [];
    const page = {
      async goto() {},
      async waitForTimeout() {},
      async evaluate() { return clicked >= 0 ? (unitsByTab[clicked] || []) : []; },
      locator(sel, opts) {
        const isReview = !!(opts && opts.hasText === '复习');
        return {
          async count() { return isReview ? reviews : 0; },
          nth(i) { return { async click() { clicked = i; clicks.push(i); } }; },
        };
      },
    };
    return { page, clicks };
  };

  await t('老段：按阶段序号点「复习」后渲染出目标 unit', async () => {
    const { page, clicks } = mockSectionPage({ unitsByTab: { 1: [28, 29, 30, 31] } });
    const r = await openOldSectionPath(page, 1, 31);
    assert.equal(r.ok, true);
    assert.equal(r.tab, 1);
    assert.deepEqual(clicks, [1]);
  });

  await t('老段：阶段序号没命中时按顺序兜底（有上限），命中即停', async () => {
    const { page, clicks } = mockSectionPage({ unitsByTab: { 1: [28, 29, 30, 31] } });
    const r = await openOldSectionPath(page, 0, 31);
    assert.equal(r.ok, true);
    assert.equal(r.tab, 1);
    assert.deepEqual(clicks, [0, 1]);
  });

  await t('老段：所有阶段都没渲染目标 unit → ok:false（记 SECTION_JUMP_UNMATCHED，不当平台不提供）', async () => {
    const { page, clicks } = mockSectionPage({ unitsByTab: {} });
    const r = await openOldSectionPath(page, 1, 31);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'SECTION_JUMP_UNMATCHED');
    assert.ok(clicks.length <= 4, '兜底尝试要有上限，实际 ' + clicks.length);
  });

  await t('页面上没有「复习」入口 → ok:false NO_REVIEW_ENTRY', async () => {
    const { page } = mockSectionPage({ reviews: 0 });
    const r = await openOldSectionPath(page, 1, 31);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'NO_REVIEW_ENTRY');
  });

  await t('老段判定：目标比当前渲染段更早才算老段（当前段靠下的仍走滚动）', async () => {
    assert.equal(isOldSegment([69, 70, 72], 30), true);
    assert.equal(isOldSegment([69, 70, 72], 127), false);
    assert.equal(isOldSegment([], 30), false, '没渲染信息时不猜老段');
    assert.equal(isOldSegment([28, 29, 30, 31], 31), false);
  });

  await t('渲染列表为空时不退缩：先试阶段入口（unit 34 曾因空取样误跳过一关）', async () => {
    assert.equal(shouldTrySectionJump([], 34), true);
    assert.equal(shouldTrySectionJump([69, 70, 72], 34), true);
    assert.equal(shouldTrySectionJump([69, 70, 72], 127), false, '当前段靠下的 unit 仍走滚动');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exitCode = 1;
})();
