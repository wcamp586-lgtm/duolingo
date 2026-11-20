// 离线验证主循环：solve 抛出 STORY_DONE_NEEDS_USER 后，main 只写一次
// STOP story-done 并退出，不轮询、不重试、不记 SKIP_SLOT。
// 不联网、不使用 profile/；用 vm + 本地 mock 替代浏览器和课程。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { URL } = require('node:url');

function fakeResponse(url, data, status = 200) {
  return {
    url: () => url,
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => data,
    request: () => ({ resourceType: () => 'fetch' }),
  };
}

async function main() {
  const logs = [];
  const errors = [];
  let currentUrl = 'https://www.duolingo.com/learn';
  let emitted = false;
  const handlers = [];
  let closed = false;

  const userResp = fakeResponse('https://www.duolingo.com/2023-05-23/users/769346152', {
    currentCourse: { id: 'C', pathSectioned: [] },
    totalXp: 100,
  });
  const sessionResp = fakeResponse('https://www.duolingo.com/2023-05-23/sessions/s1', {
    id: 's1', type: 'LESSON', challenges: [], skillId: 'skill1', levelIndex: 0,
  });

  const locator = () => ({
    first() { return this; },
    count: async () => 0,
    isVisible: async () => false,
    isEnabled: async () => false,
    boundingBox: async () => null,
    click: async () => {},
    filter() { return this; },
    waitFor: async () => {},
  });

  const page = {
    on(event, handler) { if (event === 'response') handlers.push(handler); },
    async goto(url) {
      currentUrl = url;
      if (!emitted && /\/learn/.test(url)) {
        emitted = true;
        for (const handler of handlers) {
          await handler(userResp);
          await handler(sessionResp);
        }
      }
    },
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

  const ctx = {
    pages: () => [page],
    async close() { closed = true; },
  };

  const slot = { id: 'n1', type: 'story', sectionIndex: 0, unitIndex: 0, levelIndex: 0, name: 'Story', courseId: 'C' };
  const level = {
    id: 'n1', state: 'active', type: 'story',
    pathLevelMetadata: { skillId: 'skill1', crownLevelIndex: 0 },
  };
  const modules = {
    playwright: { chromium: { launchPersistentContext: async () => ctx } },
    'node:path': path,
    'node:fs': { existsSync: () => false, readFileSync: () => '' },
    './automation-policy.js': {
      planNormal: () => [slot],
      planCourse: () => ({ candidates: [] }),
      stopDecision: () => ({ action: 'continue', reasons: [], xpGain: 0, elapsedMs: 0, mayStartNext: true }),
      createRetryTracker: () => ({ fail: () => ({ attempts: 1, action: 'retry', stop: null, streak: 1, totalAttempts: 1 }), ok: () => {}, attempts: new Map(), skipped: new Set() }),
      storyCoverAction: () => null,
      shouldClickSplash: () => false,
    },
    './core.js': require('./core.js'),
    './story-runner.js': { step: async () => ({ status: 'done' }) },
    './radio-tap.js': { run: async () => ({ status: 'not-match' }), readButtons: async () => null, waitPairing: async () => false },
    './radio-quiz.js': { run: async () => ({ status: 'done', answered: 0 }) },
    './lesson-runner.js': { step: async () => ({ status: 'waiting' }), readDom: async () => null },
    './lesson-guard.js': require('./lesson-guard.js'),
    './legendary-entry.js': {
      prepareByUrl: async () => ({ url: new URL('https://www.duolingo.com/lesson') }),
      findCourseLevel: () => level,
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
    process: { argv: ['node', 'auto-runner.js', '--normal', '--minutes', '1'], exitCode: 0, env: {} },
    console: {
      log: (...args) => logs.push(args.join(' ')),
      error: (...args) => errors.push(args.join(' ')),
    },
    __dirname,
    __filename: path.join(__dirname, 'auto-runner.js'),
    URL, setTimeout, clearTimeout, Buffer, AbortSignal,
  };
  sandbox.global = sandbox;

  const source = fs.readFileSync(path.join(__dirname, 'auto-runner.js'), 'utf8');
  const started = Date.now();
  vm.runInNewContext(source, sandbox, { filename: 'auto-runner.js' });
  // 必须人工收尾时 main 会 return 但保留 ctx：等它跑完，确认没有调用 ctx.close()
  await new Promise((resolve) => setTimeout(resolve, 500));
  const elapsed = Date.now() - started;

  const stopLines = logs.filter((line) => line.startsWith('STOP '));
  assert.deepEqual(stopLines, ['STOP story-done（最后结束课程需用户点击）']);
  assert.equal(logs.filter((line) => line.includes('SKIP_SLOT')).length, 0);
  assert.equal(logs.filter((line) => line.includes('LESSON_IDLE')).length, 0);
  assert.equal(errors.length, 0, '不应有 BLOCKED/错误输出: ' + errors.join(' | '));
  assert.equal(closed, false, '必须人工收尾时不能关闭专用浏览器');
  assert.equal(logs.filter((line) => line.includes('KEEP_OPEN')).length, 1);
  assert.ok(elapsed < 3000, '主循环应快速退出，实际 ' + elapsed + 'ms');

  console.log('  ✓ 主循环只写一次 STOP story-done，保留窗口且无 SKIP_SLOT/LESSON_IDLE');
  console.log('结果: 1 通过, 0 失败');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
