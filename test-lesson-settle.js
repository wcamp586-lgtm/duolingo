// 离线验证：普通课不能拿「题数达标」当退出依据，必须等真实完成信号（LESSON_END / 回 /learn）。
// 不联网、不使用 profile/；用 vm + mock 替代浏览器和课程。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function buildEnv({ totalChallenges = 17, answers = 17, fakeClock = false, stallAfter = null, scoreStage = false, inviteStage = false }) {
  const logs = [];
  let currentUrl = 'https://www.duolingo.com/lesson';
  let endClicks = 0;
  let stepCalls = 0;
  let now = 0;
  const locator = (sel) => ({
    first() { return this; },
    async count() {
      if (/legendary-session-end-continue/.test(sel)) return (scoreStage || inviteStage) ? 0 : (endClicks === 0 ? 1 : 0);
      if (scoreStage && /has-text\("继续"\)/.test(sel)) return 1;
      if (inviteStage && /不，谢谢/.test(sel)) return 1;
      return 0;
    },
    async isVisible() { return /legendary-session-end-continue/.test(sel) || (scoreStage && /has-text\("继续"\)/.test(sel)) || (inviteStage && /不，谢谢/.test(sel)); },
    async evaluate() { return { tag: 'button', role: '', test: '', text: '不，谢谢' }; },
    async isEnabled() { return true; },
    async boundingBox() { return null; },
    async click() {
      if (/legendary-session-end-continue/.test(sel)) {
        endClicks++;
        currentUrl = 'https://www.duolingo.com/learn';
      }
      if (scoreStage && /has-text\("继续"\)/.test(sel)) {
        currentUrl = 'https://www.duolingo.com/learn';
      }
      if (inviteStage && /不，谢谢/.test(sel)) {
        currentUrl = 'https://www.duolingo.com/learn';
      }
    },
    filter() { return this; },
    async waitFor() {},
    async innerText() { return ''; },
    async getAttribute() { return null; },
  });
  const page = {
    on() {},
    async goto(url) { currentUrl = url; },
    url: () => currentUrl,
    async evaluate() { return ''; },
    async waitForTimeout() {},
    async waitForURL() {},
    async screenshot() {},
    isClosed: () => false,
    async close() {},
    locator,
    mouse: { click: async () => {} },
  };
  const modules = {
    playwright: { chromium: { launchPersistentContext: async () => ({ pages: () => [page], close: async () => {} }) } },
    'node:path': path,
    'node:fs': { existsSync: () => false, readFileSync: () => '' },
    './automation-policy.js': {
      planNormal: () => [],
      planCourse: () => ({ candidates: [] }),
      stopDecision: () => ({ action: 'continue', reasons: [], xpGain: 0, elapsedMs: 0, mayStartNext: true }),
      createRetryTracker: () => ({ fail: () => ({ attempts: 1, action: 'retry', stop: null, streak: 1, totalAttempts: 1 }), ok: () => {}, attempts: new Map(), skipped: new Set() }),
      chainReport: () => ({ headsGold: 0, chainsGold: 0, pending: [], ready: [], absent: [], unknown: [], courseNotGold: 0 }),
    },
    './core.js': require('./core.js'),
    './story-runner.js': { step: async () => ({ status: 'waiting' }) },
    './radio-tap.js': { run: async () => ({ status: 'not-match' }) },
    './radio-quiz.js': { run: async () => ({ status: 'done', answered: 0 }) },
    './lesson-runner.js': {
      readDom: async () => (stallAfter ? { type: 'select', options: ['a'], boxText: 'x' } : (stepCalls < answers ? { type: 'select', options: ['a'], boxText: 'x' } : null)),
      step: async () => {
        stepCalls++;
        if (stallAfter && stepCalls > stallAfter) return { status: 'waiting' };
        return { status: 'answered', type: 'select' };
      },
      advance: async () => {},
      fillInput: async () => true,
    },
    './lesson-guard.js': {
      readPageState: async () => (inviteStage && stepCalls >= answers
        ? { url: '/lesson', hasChallenge: false, hasQuitButton: false, hasEndButton: false, nextEnabled: false, nextText: '', text: '来向我们展示你的传奇实力吧 完成这个超硬核挑战，晋升到传奇等级！ 开始 +40 经验 不，谢谢 继续' }
        : (scoreStage && stepCalls >= answers
          ? { url: '/lesson', hasChallenge: false, hasQuitButton: false, hasEndButton: false, nextEnabled: false, nextText: '', text: '31 离提升你的法语分数又近了一步！ 31 32 继续' }
          : { url: currentUrl, hasChallenge: false, hasQuitButton: false, text: '' })),
      classifyPage: () => 'non-question',
      describePage: () => '',
      createProgressGuard: () => ({ touch() {}, expired() { return false; } }),
      noProgressError: () => new Error('no-progress'),
    },
    './legendary-entry.js': {
      prepareByUrl: async () => ({ url: new URL('https://www.duolingo.com/lesson') }),
      prepareByNode: async () => ({ url: new URL('https://www.duolingo.com/lesson') }),
      findCourseLevel: () => null,
      LEARN: /^https:\/\/www\.duolingo\.com\/learn(?:[/?#]|$)/,
      ORIGIN: 'https://www.duolingo.com',
    },
  };
  const mockRequire = (name) => {
    if (!(name in modules)) throw new Error('unexpected require: ' + name);
    return modules[name];
  };
  const module = { exports: {} };
  mockRequire.main = module;
  const sandbox = {
    require: mockRequire,
    module,
    exports: module.exports,
    process: { argv: ['node', 'auto-runner.js', '--normal'], env: {}, exitCode: 0 },
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
    __dirname,
    __filename: path.join(__dirname, 'auto-runner.js'),
    URL,
    // mock 定时器立即执行，避免 400 轮里 clickSafe/wait 的真实等待
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout: () => {},
    Buffer,
    AbortSignal,
    Date: fakeClock ? { now: () => (now += 1000) } : Date,
  };
  const script = new vm.Script(fs.readFileSync(path.join(__dirname, 'auto-runner.js'), 'utf8'), { filename: 'auto-runner.js' });
  script.runInNewContext(sandbox);
  return { solve: module.exports.solve, page, target: { mode: 'normal', slot: { type: 'skill', id: 'n1' }, data: { challenges: Array.from({ length: totalChallenges }, (_, i) => ({ id: 'c' + i })) } }, check: async () => {}, logs, state: { get endClicks() { return endClicks; } } };
}

(async () => {
  let pass = 0, fail = 0;
  const t = async (name, fn) => {
    try { await fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + ' -> ' + e.message); }
  };

  console.log('lesson-settle');
  await t('题数到 17 但仍在反馈页：不 return，等完成信号才收尾', async () => {
    const env = buildEnv({ totalChallenges: 17, answers: 17 });
    const answered = await env.solve(env.page, env.target, env.check);
    assert.equal(answered, 17);
    assert.equal(env.state.endClicks, 1, '必须点完成页的结束/继续按钮，而不是题数一到就 return');
  });

  await t('题数到 17 且一直停在反馈页：超时不结算（不 return）', async () => {
    const env = buildEnv({ totalChallenges: 17, answers: 17, fakeClock: true, stallAfter: 17 });
    let err = null;
    try { await env.solve(env.page, env.target, env.check); } catch (e) { err = e; }
    assert.ok(err, '应抛错而不是静默 return');
    assert.match(err.message, /等待普通课反馈或结算超时|no-progress|步数上限/);
  });

  await t('分数升级过场（无 player-next，只有「继续」）：点继续回路径并结算', async () => {
    const env = buildEnv({ totalChallenges: 17, answers: 17, scoreStage: true });
    const answered = await env.solve(env.page, env.target, env.check);
    assert.equal(answered, 17);
    assert.ok(env.logs.some((l) => /LESSON_SCORE_CONTINUE/.test(l)), '应识别分数过场继续');
  });

  await t('正常结课后的传说邀请：选「不，谢谢」→ 回路径，不记失败', async () => {
    const env = buildEnv({ totalChallenges: 17, answers: 17, inviteStage: true });
    const answered = await env.solve(env.page, env.target, env.check);
    assert.equal(answered, 17);
    assert.ok(env.logs.some((l) => /LEGENDARY_INVITE_DECLINED/.test(l)), '应识别传说邀请并选不，谢谢');
    assert.ok(!env.logs.some((l) => /NODE_FAIL/.test(l)));
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exitCode = 1;
})();
