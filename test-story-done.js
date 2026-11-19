// 离线验证：故事全部答完、停在结束按钮时，外层不再空转。
// 不联网、不使用 profile/；只启无头浏览器加载本地 HTML。
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

async function main() {
  const guardModule = require('./lesson-guard.js');
  const realCreate = guardModule.createProgressGuard;
  let touches = 0;
  guardModule.createProgressGuard = (...args) => {
    const guard = realCreate(...args);
    const realTouch = guard.touch.bind(guard);
    guard.touch = () => { touches++; realTouch(); };
    return guard;
  };
  const autoRunner = require('./auto-runner.js');
  const storyRunner = require('./story-runner.js');

  const session = {
    elements: [{
      type: 'MULTIPLE_CHOICE', lineIndex: 1,
      question: { text: 'Priti 看到谁了？' },
      answers: [
        { text: 'Vikram 最喜欢的篮球运动员' },
        { text: '她最喜欢的篮球运动员' },
        { text: '几个正在玩游戏的人' },
      ],
      correctAnswerIndex: 0,
    }],
  };

  let pass = 0, fail = 0;
  const t = async (name, fn) => {
    try { await fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + ' -> ' + e.message); }
  };

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const choice = (label) => `<li><span>${label}</span><button data-test="stories-choice" style="width:20px;height:20px" onclick="document.querySelector('[data-test=stories-player-continue]').disabled=false"></button></li>`;
    await page.setContent(`
      <div data-test="stories-element">
        <ul>
          ${choice('Vikram 最喜欢的篮球运动员')}
          ${choice('她最喜欢的篮球运动员')}
          ${choice('几个正在玩游戏的人')}
        </ul>
        <button data-test="stories-player-continue" disabled>继续</button>
      </div>
    `);

    let doneResult = null;
    let solveError = null;
    let solveMs = 0;

    await t('故事题可以作答（准备 done 状态）', async () => {
      const result = await storyRunner.step(page, session);
      assert.equal(result.status, 'answered');
    });

    await t('done 只记录一次 STORY_DONE', async () => {
      const logs = [];
      const orig = console.log;
      console.log = (...args) => { logs.push(args.join(' ')); orig(...args); };
      try {
        doneResult = await storyRunner.step(page, session);
      } finally {
        console.log = orig;
      }
      assert.equal(doneResult.status, 'done');
      assert.equal(logs.filter((line) => line.startsWith('STORY_DONE')).length, 1);
    });

    await t('solve 在 done 后立即抛出 STORY_DONE_NEEDS_USER', async () => {
      const target = { slot: { type: 'story' }, data: session, mode: 'normal', startedAt: Date.now() };
      const started = Date.now();
      try {
        await autoRunner.solve(page, target, async () => {});
      } catch (error) {
        solveError = error;
      }
      solveMs = Date.now() - started;
      assert.ok(solveError, '应抛错退出');
      assert.match(solveError.message, /STORY_DONE_NEEDS_USER/);
    });

    await t('不会误报无题页面超时、也不会空转', () => {
      assert.ok(solveError);
      assert.doesNotMatch(solveError.message, /无题页面停滞/);
      // 结束控件最多点一次并观察 10 秒；超过就是空转
      assert.ok(solveMs < 15000, '应在结束控件验证窗口内退出，实际 ' + solveMs + 'ms');
    });

    await t('done 不会调用 progress.touch()', () => {
      assert.equal(touches, 0);
    });
  } finally {
    await browser.close();
  }

  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
