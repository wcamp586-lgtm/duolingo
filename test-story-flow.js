// 离线验证故事入口与收尾顺序：
// 1) 故事封面在 target.data 还没到时也要点「开始读故事」（原来等数据才点，形成死锁）；
// 2) 答完后点明确识别到的结束控件，只有页面真的变化才继续，回到 /learn 才算结算路径走通；
// 3) 结束控件点了没变化时只点一次，交回外层保留窗口，不重复盲点。
// 不联网、不使用 profile/；用 mock page。
const assert = require('node:assert/strict');
const autoRunner = require('./auto-runner.js');
const storyRunner = require('./story-runner.js');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' -> ' + e.message); }
};

const state = (url) => ({
  url: new URL(url).pathname + new URL(url).search,
  hasChallenge: false,
  hasLoading: false,
  hasStoryCover: false,
  hasEndButton: false,
  hasQuitButton: false,
  nextEnabled: false,
  text: '',
});

function makePage({ cover = false, endControl = false, endNavigates = true, endDelay = 0 } = {}) {
  let url = 'https://www.duolingo.com/lesson';
  let coverClicks = 0;
  let endClicks = 0;
  let endReady = endDelay === 0;

  const mk = (count, onClick) => {
    const loc = {
      first() { return loc; },
      nth() { return loc; },
      filter() { return loc; },
      waitFor: async () => {},
      count: async () => (typeof count === 'function' ? count() : count),
      isVisible: async () => (typeof count === 'function' ? count() : count) > 0,
      isEnabled: async () => true,
      boundingBox: async () => null,
      click: async () => {
        if (onClick) await onClick();
      },
    };
    return loc;
  };

  const page = {
    url: () => url,
    async goto(u) { url = u; },
    async evaluate() { return state(url); },
    async waitForTimeout() { endReady = true; },
    async waitForURL() {},
    keyboard: { press: async () => {} },
    mouse: { click: async () => {} },
    locator(selector) {
      if (selector.includes('stories-player-done')) return mk(0);
      if (selector.includes('story-start')) return mk(cover ? 1 : 0, () => { coverClicks++; });
      if (selector.includes('stories-player-continue')) {
        return mk(() => (endControl && endReady ? 1 : 0), () => {
          endClicks++;
          if (endNavigates) url = 'https://www.duolingo.com/learn';
        });
      }
      if (selector.includes('legendary-session-end-continue')) return mk(0);
      if (selector.includes('结束课程')) return mk(0);
      return mk(0);
    },
  };
  return { page, counters: { cover: () => coverClicks, end: () => endClicks } };
}

async function solveWith(page, target, check = async () => {}) {
  return autoRunner.solve(page, target, check);
}

async function main() {
  await t('数据未到时也会点一次封面，超时按故事 120 秒报错，不加大重试', async () => {
    const { page, counters } = makePage({ cover: true });
    const target = { slot: { type: 'story' }, data: null, mode: 'normal', startedAt: Date.now() - 44000 };
    let error = null;
    const check = async () => {
      // 第二轮开始前把起点推到 120 秒之前，触发故事页的数据超时，避免测试真的等
      if (counters.cover() > 0) target.startedAt = Date.now() - 121000;
    };
    try { await solveWith(page, target, check); } catch (e) { error = e; }
    assert.equal(counters.cover(), 1, '封面应被点击一次');
    assert.ok(error);
    assert.match(error.message, /未收到与目标节点匹配的课程数据/);
    assert.doesNotMatch(error.message, /无题页面停滞/);
  });

  await t('done 后点明确的结束控件，回到 /learn 即走通结算路径', async () => {
    const { page, counters } = makePage({ endControl: true });
    const target = { slot: { type: 'story' }, data: { elements: [{ type: 'MULTIPLE_CHOICE', answers: [] }] }, mode: 'normal', startedAt: Date.now() };
    const orig = storyRunner.step;
    storyRunner.step = async () => ({ status: 'done' });
    let result = null;
    let error = null;
    try { result = await solveWith(page, target); } catch (e) { error = e; }
    finally { storyRunner.step = orig; }
    assert.equal(error, null, error && error.message);
    assert.equal(result, 0);
    assert.equal(counters.end(), 1, '结束控件应点一次');
  });

  await t('结束控件晚渲染：5 秒窗口内等到再点，不误判 manual', async () => {
    const { page, counters } = makePage({ endControl: true, endDelay: 2 });
    const target = { slot: { type: 'story' }, data: { elements: [{ type: 'MULTIPLE_CHOICE', answers: [] }] }, mode: 'normal', startedAt: Date.now() };
    const orig = storyRunner.step;
    storyRunner.step = async () => ({ status: 'done' });
    let result = null;
    let error = null;
    try { result = await solveWith(page, target); } catch (e) { error = e; }
    finally { storyRunner.step = orig; }
    assert.equal(error, null, error && error.message);
    assert.equal(result, 0);
    assert.equal(counters.end(), 1);
  });

  await t('结束控件点了但页面没变：只点一次，抛需要人工，不重复盲点', async () => {
    const { page, counters } = makePage({ endControl: true, endNavigates: false });
    const target = { slot: { type: 'story' }, data: { elements: [{ type: 'MULTIPLE_CHOICE', answers: [] }] }, mode: 'normal', startedAt: Date.now() };
    const orig = storyRunner.step;
    storyRunner.step = async () => ({ status: 'done' });
    let error = null;
    try { await solveWith(page, target); } catch (e) { error = e; }
    finally { storyRunner.step = orig; }
    assert.ok(error);
    assert.match(error.message, /STORY_DONE_NEEDS_USER/);
    assert.match(error.message, /no-change/);
    assert.equal(counters.end(), 1, '没变化不应重复点击');
  });

  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
