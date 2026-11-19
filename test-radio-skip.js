// 离线验证 radio 推进记录：点「稍后选择」本身不算成功。
// 只有同一 unit 的后续节点打开、点「开始」成功、并且题目/挑战容器真的出现，
// 才记唯一一条 RADIO_ADVANCED。其余情况一律抛错（待处理），不记成功。
// 不联网、不用 profile/；只 mock page 和 lessonGuard.readPageState。
const assert = require('node:assert/strict');
const autoRunner = require('./auto-runner.js');
const lessonGuard = require('./lesson-guard.js');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' -> ' + e.message); }
};

// mock 学习路径 + 课程页。stage 只有 learn / lesson；lessonKind 控制是否出现挑战容器。
function makePage({
  hasLater = true,
  laterClickThrows = false,
  pageChanges = true,
  nodeCount = 1,
  nodeClickThrows = false,
  startClickThrows = false,
  wrongNav = false,
  wrongRouteWithContainer = false,
  startCount = 1,
  lessonKind = 'question',
  selfCount = 0,
  selfText = '',
  unitText = '',
  practiceIntro = false,
} = {}) {
  let laterVisible = hasLater;
  let stage = 'learn';
  let startClicked = false;
  let nodeClicked = 0;

  const makeLocator = ({ count = 1, click } = {}) => {
    const loc = {
      first() { return loc; },
      filter() { return loc; },
      waitFor: async () => {},
      scrollIntoViewIfNeeded: async () => {},
      count: async () => (typeof count === 'function' ? count() : count),
      click: async () => { if (click) await click(); },
    };
    return loc;
  };

  const radio = makeLocator();
  const node = makeLocator({
    count: () => nodeCount,
    click: async () => {
      if (nodeClickThrows) throw new Error('node click timeout');
      nodeClicked++;
    },
  });
  const later = makeLocator({
    count: () => (laterVisible ? 1 : 0),
    click: async () => {
      if (laterClickThrows) throw new Error('later click timeout');
      if (pageChanges) laterVisible = false;
    },
  });
  const start = makeLocator({
    count: () => startCount,
    click: async () => {
      if (startClickThrows) throw new Error('start click timeout');
      startClicked = true;
      stage = practiceIntro ? 'intro' : (wrongNav ? 'learn' : (wrongRouteWithContainer ? 'other' : 'lesson'));
    },
  });
  const practiceStart = makeLocator({
    count: () => (stage === 'intro' ? 1 : 0),
    click: async () => { stage = 'lesson'; },
  });
  const self = {
    first() { return self; },
    nth() { return self; },
    filter() { return self; },
    waitFor: async () => {},
    count: async () => selfCount,
    isVisible: async () => true,
    isEnabled: async () => true,
    innerText: async () => selfText,
    click: async () => { stage = 'lesson'; },
  };
  node.getAttribute = async () => 'skill-path-level-1 skill-path-level-practice';
  const unit = {
    first() { return unit; },
    waitFor: async () => {},
    scrollIntoViewIfNeeded: async () => {},
    evaluate: async () => unitText,
    locator(selector) {
      if (selector.includes('duo_radio')) return radio;
      if (selector.includes('skill-path-state')) return self;
      return node;
    },
  };
  const page = {
    async goto() {},
    async waitForTimeout() {},
    async waitForURL() {},
    url() {
      if (stage === 'lesson') return 'https://www.duolingo.com/lesson';
      if (stage === 'other') return 'https://www.duolingo.com/other';
      return 'https://www.duolingo.com/learn';
    },
    async evaluate() { return stage === 'lesson' ? '题目' : '别的页面'; },
    keyboard: { press: async () => {} },
    locator(selector) {
      if (selector.includes('稍后选择')) return later;
      if (/开始练习/.test(selector)) return practiceStart;
      if (selector.includes('skill-path-unit-')) return unit;
      if (selector.includes('skill-path-state-active')) return start;
      return node;
    },
  };

  // 与 lesson-guard.readPageState 的返回结构一致；url 是 pathname。
  page.__pageState = () => {
    if (stage === 'other') {
      // 非课程路由，但页面上恰好也有类似挑战容器：用于验证路由检查先于容器检查。
      return {
        url: '/other',
        hasChallenge: true,
        hasLoading: false,
        hasStoryCover: false,
        hasEndButton: false,
        hasQuitButton: false,
        nextEnabled: false,
        text: '别的页面',
      };
    }
    if (stage === 'intro') {
      return {
        url: '/lesson', hasChallenge: false, hasLoading: false, hasStoryCover: false,
        hasEndButton: false, hasQuitButton: false, nextEnabled: false,
        text: '来巩固一下你最薄弱的语法知识点吧！ 包含介词的动词 开始练习',
      };
    }
    const lesson = stage === 'lesson';
    return {
      url: lesson ? '/lesson' : '/learn',
      hasChallenge: lesson && lessonKind === 'question',
      hasLoading: lesson && lessonKind === 'loading',
      hasStoryCover: false,
      hasEndButton: false,
      hasQuitButton: lesson && lessonKind !== 'question',
      nextEnabled: lesson && lessonKind === 'question',
      text: lesson ? (lessonKind === 'question' ? '题目' : '加载中') : '学习路径',
    };
  };
  return { page, counters: { startClicked: () => startClicked, nodeClicked: () => nodeClicked } };
}

async function runCase(options) {
  const { page, counters } = makePage(options);
  const logs = [];
  const origLog = console.log;
  const origRead = lessonGuard.readPageState;
  lessonGuard.readPageState = async () => page.__pageState();
  console.log = (...args) => { logs.push(args.join(' ')); };
  let result = null;
  let error = null;
  try {
    const onTarget = (li) => ({ courseId: 'C', sectionIndex: 3, unitIndex: 71, levelIndex: li, id: 'uuid-practice-71-' + li, type: 'practice', name: 'Course Practice 70' });
    result = await autoRunner.prepareDeferredRadio(page, async () => {}, {
      sectionIndex: 3, unitIndex: 71, levelIndex: 0, id: 's3u71l0', name: 'Le théâtre à Montréal',
    }, onTarget);
  } catch (e) {
    error = e;
  } finally {
    console.log = origLog;
    lessonGuard.readPageState = origRead;
  }
  return { result, error, logs, counters };
}

async function main() {
  await t('练习介绍页：点唯一「开始练习」后出现题目容器 → RADIO_ADVANCED + 后继节点身份', async () => {
    const { result, error, logs } = await runCase({ practiceIntro: true });
    assert.equal(error, null);
    assert.ok(logs.some((l) => /RADIO_NEXT_PRACTICE_INTRO/.test(l)), '应识别练习介绍页');
    assert.equal(result.advanced, true);
    assert.equal(result.nextId, 'uuid-practice-71-1');
    assert.equal(result.nextSlot.type, 'practice');
  });
  await t('真推进：后续节点打开、开始点击成功、挑战容器出现 → 只记一条 RADIO_ADVANCED', async () => {
    const r = await runCase({});
    assert.equal(r.error, null);
    assert.equal(r.result.advanced, true);
    assert.equal(r.result.nextId, 'uuid-practice-71-1');
    assert.equal(r.counters.startClicked(), true);
    const advanced = r.logs.filter((line) => line.includes('RADIO_ADVANCED'));
    assert.equal(advanced.length, 1);
    assert.match(advanced[0], /id=s3u71l0 next=uuid-practice-71-1 type=practice evidence=question url=\/lesson/);
    assert.ok(!r.logs.some((line) => line.includes('RADIO_SKIPPED')));
    assert.ok(!r.logs.some((line) => line.includes('RADIO_NEXT')));
  });

  await t('多个「开始」同时可见且无法唯一对应 → RADIO_NEXT_AMBIGUOUS，零点击', async () => {
    const r = await runCase({ startCount: 2 });
    assert.ok(r.error);
    assert.match(r.error.message, /RADIO_NEXT_AMBIGUOUS next=s3u71l1 candidates=2/);
    assert.equal(r.counters.nodeClicked(), 1);
    assert.equal(r.counters.startClicked(), false);
    assert.ok(!r.logs.some((line) => line.includes('RADIO_ADVANCED')));
  });

  await t('非课程路由但页面上有类似容器 → RADIO_WRONG_PAGE，不判成功', async () => {
    const r = await runCase({ wrongRouteWithContainer: true });
    assert.ok(r.error);
    assert.match(r.error.message, /RADIO_WRONG_PAGE next=s3u71l1 url=\/other/);
    assert.equal(r.counters.startClicked(), true);
    assert.ok(!r.logs.some((line) => line.includes('RADIO_ADVANCED')));
  });

  await t('只有弹窗收起、没有可进入的后续节点 → RADIO_NO_PROGRESS，不记成功', async () => {
    const r = await runCase({ nodeCount: 0 });
    assert.ok(r.error);
    assert.match(r.error.message, /RADIO_NO_PROGRESS/);
    assert.equal(r.result, null);
    assert.ok(!r.logs.some((line) => line.includes('RADIO_ADVANCED')));
  });

  await t('找到后续节点但节点点击失败 → RADIO_NEXT_CLICK_FAILED step=node', async () => {
    const r = await runCase({ nodeClickThrows: true });
    assert.ok(r.error);
    assert.match(r.error.message, /RADIO_NEXT_CLICK_FAILED next=s3u71l1 step=node/);
    assert.equal(r.counters.startClicked(), false);
    assert.ok(!r.logs.some((line) => line.includes('RADIO_ADVANCED')));
  });

  await t('找到「开始」但点击失败 → RADIO_NEXT_CLICK_FAILED step=start', async () => {
    const r = await runCase({ startClickThrows: true });
    assert.ok(r.error);
    assert.match(r.error.message, /RADIO_NEXT_CLICK_FAILED next=s3u71l1 step=start/);
    assert.equal(r.counters.startClicked(), false);
    assert.ok(!r.logs.some((line) => line.includes('RADIO_ADVANCED')));
  });

  await t('点「开始」后误导航回 /learn → RADIO_WRONG_PAGE，不记成功', async () => {
    const r = await runCase({ wrongNav: true });
    assert.ok(r.error);
    assert.match(r.error.message, /RADIO_WRONG_PAGE next=s3u71l1 url=\/learn/);
    assert.ok(!r.logs.some((line) => line.includes('RADIO_ADVANCED')));
  });

  await t('停在 /lesson 但没有题目/挑战容器 → RADIO_NO_PROGRESS', async () => {
    const r = await runCase({ lessonKind: 'loading' });
    assert.ok(r.error);
    assert.match(r.error.message, /RADIO_NO_PROGRESS next=s3u71l1 reason=课程界面未出现题目容器/);
    assert.ok(!r.logs.some((line) => line.includes('RADIO_ADVANCED')));
  });

  await t('没有跳过入口、但有唯一电台自身入口 → RADIO_DIRECT 正常进课', async () => {
    const r = await runCase({ hasLater: false, selfCount: 1, selfText: '听力练习 +30 经验', unitText: 'Le théâtre à Montréal 听力练习 +30 经验' });
    assert.equal(r.error, null);
    assert.equal(r.result.radioDirect, true);
    assert.ok(r.logs.some((line) => line.includes('RADIO_DIRECT id=s3u71l0 entry="听力练习 +30 经验"')));
    assert.ok(!r.logs.some((line) => line.includes('RADIO_SKIPPED')));
  });

  await t('根本没有「稍后选择」入口 → RADIO_UNSUPPORTED', async () => {
    const r = await runCase({ hasLater: false });
    assert.ok(r.error);
    assert.match(r.error.message, /RADIO_UNSUPPORTED/);
    assert.equal(r.counters.startClicked(), false);
    assert.equal(r.counters.nodeClicked(), 0);
  });

  await t('点「稍后选择」失败 → RADIO_SKIP_CLICK_FAILED，不记成功', async () => {
    const r = await runCase({ laterClickThrows: true });
    assert.ok(r.error);
    assert.match(r.error.message, /RADIO_SKIP_CLICK_FAILED/);
    assert.equal(r.counters.startClicked(), false);
  });

  await t('点「稍后选择」后页面完全没变 → RADIO_SKIP_NO_CHANGE，不记成功', async () => {
    const r = await runCase({ pageChanges: false });
    assert.ok(r.error);
    assert.match(r.error.message, /RADIO_SKIP_NO_CHANGE/);
    assert.equal(r.counters.startClicked(), false);
  });

  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
