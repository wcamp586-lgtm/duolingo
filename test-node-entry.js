// 离线验证普通故事节点入口：token 定位 + 类型/active 核对 + 气泡关联（同 unit、唯一开始、
// 标题匹配平台 storyName），证不出来就 NODE_ENTRY_* 一次收口。
// 不联网、不使用 profile/；只 mock page。
const assert = require('node:assert/strict');
const autoRunner = require('./auto-runner.js');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' -> ' + e.message); }
};

function makePage({
  nodeCount = 1,
  nodeTest = 'skill-path-level-4 skill-path-level-story skill-path-state-active',
  starts = [{ test: 'skill-path-state-active skill-path-unit-test-71', text: '开始 +60 经验', pathname: '/lesson', params: ['storyId'], box: 'skill-path-level-4' }],
  bubbleText = '讨论戏剧表演 Lumières pour la planète... 开始 +60 经验',
} = {}) {
  let url = 'https://www.duolingo.com/learn';
  let startClicks = 0;
  const start = {
    first() { return start; },
    filter() { return start; },
    count: async () => 1,
    click: async () => { startClicks++; url = 'https://www.duolingo.com/lesson'; },
  };
  const node = {
    first() { return node; },
    count: async () => nodeCount,
    evaluate: async () => ({ test: nodeTest }),
    click: async () => {},
  };
  const nodes = {
    count: async () => nodeCount,
    first() { return node; },
  };
  const unit = {
    first() { return unit; },
    waitFor: async () => {},
    scrollIntoViewIfNeeded: async () => {},
    locator(selector) {
      if (selector.includes('skill-path-level-')) return nodes;
      if (selector.includes('skill-path-state-active')) return start;
      return nodes;
    },
    evaluate: async (fn, name) => (name
      ? { starts, text: bubbleText }
      : { starts: [] }),
  };
  const page = {
    url: () => url,
    async goto() { url = 'https://www.duolingo.com/learn'; },
    async waitForTimeout() {},
    async waitForURL() {},
    locator(selector) {
      if (selector.includes('skill-path-unit-')) return unit;
      if (selector.includes('skill-path-state-active')) return start;
      return nodes;
    },
  };
  return { page, startClicks: () => startClicks };
}

const slot = { sectionIndex: 3, unitIndex: 71, levelIndex: 4, id: 's3u71l4', type: 'story', name: 'Lights for the Planet…', state: 'active' };
const level = { state: 'active', type: 'story', pathLevelClientData: { storyName: 'Lumières pour la planète…' } };

async function main() {
  await t('token 定位 + 类型/active + 气泡标题匹配（省略号归一化）→ 点开始进 /lesson', async () => {
    const page = makePage();
    const entry = await autoRunner.prepareByStoryNode(page.page, async () => {}, slot, level);
    assert.equal(entry.nodeEntry, true);
    assert.equal(entry.url.pathname, '/lesson');
  });

  await t('同一单元多个 level 节点：NODE_ENTRY_AMBIGUOUS，不点击', async () => {
    await assert.rejects(
      () => autoRunner.prepareByStoryNode(makePage({ nodeCount: 2 }).page, async () => {}, slot, level),
      /NODE_ENTRY_AMBIGUOUS nodes=2/,
    );
  });

  await t('节点类型不是 story：NODE_ENTRY_UNMATCHED', async () => {
    await assert.rejects(
      () => autoRunner.prepareByStoryNode(makePage({ nodeTest: 'skill-path-level-4 skill-path-level-skill skill-path-state-active' }).page, async () => {}, slot, level),
      /NODE_ENTRY_UNMATCHED 类型不符/,
    );
  });

  await t('节点本身是 unit-test 候选不能冒充：NODE_ENTRY_UNMATCHED', async () => {
    await assert.rejects(
      () => autoRunner.prepareByStoryNode(makePage({ nodeTest: 'skill-path-level-4 skill-path-unit-test-71' }).page, async () => {}, slot, level),
      /NODE_ENTRY_UNMATCHED unit-test/,
    );
  });

  await t('气泡里多个开始：NODE_ENTRY_AMBIGUOUS starts=2', async () => {
    await assert.rejects(
      () => autoRunner.prepareByStoryNode(makePage({ starts: [{ test: 'a', pathname: '/lesson' }, { test: 'b', pathname: '/lesson' }] }).page, async () => {}, slot, level),
      /NODE_ENTRY_AMBIGUOUS starts=2/,
    );
  });

  await t('href 指向单元测试/跳级：NODE_ENTRY_UNSAFE，不点击', async () => {
    const made = makePage({ starts: [{ test: 'skill-path-state-active', text: '开始', pathname: '/lesson/unit-test/71', params: [] }] });
    await assert.rejects(
      () => autoRunner.prepareByStoryNode(made.page, async () => {}, slot, level),
      /NODE_ENTRY_UNSAFE/,
    );
    assert.equal(made.startClicks(), 0);
  });

  await t('气泡标题不匹配 storyName：NODE_ENTRY_UNMATCHED', async () => {
    await assert.rejects(
      () => autoRunner.prepareByStoryNode(makePage({ bubbleText: '别的内容 开始 +30 经验' }).page, async () => {}, slot, level),
      /NODE_ENTRY_UNMATCHED 气泡标题不匹配/,
    );
  });

  await t('缺少平台 storyName：NODE_ENTRY_UNSUPPORTED', async () => {
    await assert.rejects(
      () => autoRunner.prepareByStoryNode(makePage().page, async () => {}, slot, { state: 'active', type: 'story' }),
      /NODE_ENTRY_UNSUPPORTED 缺少/,
    );
  });

  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
