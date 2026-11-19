// 离线验证「作答进展」判定回归（2026-11-20 s2u42l7：同一 name 题被记 356 次 answered）：
// 1) 单纯 DOM 不变不算进展；2) 反馈出现/换题才算；3) 同题 30 秒停滞必须触发停止；4) 点击异常可诊断。
// 不联网、不使用 profile。
const assert = require('node:assert/strict');
const { challengeSig, classifySubmit, sameTickState, advance, afterSubmit } = require('./lesson-runner.js');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' -> ' + e.message); }
};

const dom = (o = {}) => ({ type: 'name', boxText: '填写：名字', options: ['A', 'B'], hasInput: true, ...o });

(async () => {
  console.log('lesson-progress');

  await t('题目指纹：题型/题干/选项任一变化都算换题', async () => {
    assert.notEqual(challengeSig(dom()), challengeSig(dom({ boxText: '填写：另一个名字' })));
    assert.notEqual(challengeSig(dom()), challengeSig(dom({ type: 'translate' })));
    assert.notEqual(challengeSig(dom()), challengeSig(dom({ options: ['A', 'C'] })));
    assert.equal(challengeSig(dom()), challengeSig(dom()));
    assert.equal(challengeSig(null), '');
  });

  await t('同一 name 题、按钮不变、点击无效 → same（绝不记 answered）', async () => {
    assert.equal(classifySubmit(dom(), dom(), '检查'), 'same');
    assert.equal(classifySubmit(dom(), dom(), ''), 'same');
  });

  await t('反馈延迟到达（按钮变「继续」）→ feedback，算进展', async () => {
    assert.equal(classifySubmit(dom(), dom(), '继续'), 'feedback');
  });

  await t('正常换到下一题 → changed，算进展', async () => {
    assert.equal(classifySubmit(dom(), dom({ boxText: '下一题' }), '检查'), 'changed');
  });

  await t('已经离开题目页 → left，算进展', async () => {
    assert.equal(classifySubmit(dom(), null, ''), 'left');
  });

  await t('同一题 30 秒停滞触发 abort（签名不变）', async () => {
    let state = null;
    const t0 = 1000000;
    let s = sameTickState('sig-1', state, t0);
    assert.equal(s.abort, false, '刚出现不该停');
    assert.equal(s.since, t0);
    state = { sig: s.sig, since: s.since };
    s = sameTickState('sig-1', state, t0 + 15000);
    assert.equal(s.abort, false, '15 秒不该停');
    s = sameTickState('sig-1', state, t0 + 31000);
    assert.equal(s.abort, true, '超过 30 秒必须停');
  });

  await t('换题会重置停滞计时', async () => {
    let s = sameTickState('sig-1', null, 1000);
    let state = { sig: s.sig, since: s.since };
    s = sameTickState('sig-2', state, 40000);
    assert.equal(s.abort, false);
    assert.equal(s.since, 40000);
    state = { sig: s.sig, since: s.since };
    s = sameTickState('sig-2', state, 45000);
    assert.equal(s.abort, false);
  });

  await t('点击异常可诊断：记录异常文本，不无条件当成功', async () => {
    let clicks = 0;
    const page = {
      async waitForFunction() { return true; },
      locator() {
        const self = {
          // k=1 只点「继续」：这题按钮仍是「检查」，过滤后不存在
          filter() { return { async count() { return 0; } }; },
          async count() { return 1; },
          async click() { clicks++; throw new Error('element is not stable'); },
          async isEnabled() { return true; },
        };
        return self;
      },
    };
    const r = await advance(page, async () => {});
    assert.equal(clicks, 1, '点击会被尝试');
    assert.equal(r.clicked, 0, '失败不能算点中');
    assert.equal(r.errors.length, 1);
    assert.ok(/not stable/.test(r.errors[0]), '异常文本要保留：' + r.errors[0]);
  });

  await t('按钮不可点（disabled/遮挡）→ footer-not-ready，不点也不记成功', async () => {
    let clicks = 0;
    const page = {
      async waitForFunction() { throw new Error('waitForFunction timeout'); },
      locator() {
        const self = {
          filter() { return { async count() { return 0; } }; },
          async count() { return 1; },
          async click() { clicks++; },
          async isEnabled() { return false; },
        };
        return self;
      },
    };
    const r = await advance(page, async () => {});
    assert.equal(clicks, 0);
    assert.deepEqual(r.errors, ['footer-not-ready']);
  });

  await t('签名忽略自己填进输入框的内容（promptText 相同就不算换题）', async () => {
    const a = dom({ promptText: '用英语写出这个名字 安娜。', boxText: '用英语写出这个名字 安娜。' });
    const b = dom({ promptText: '用英语写出这个名字 安娜。', boxText: '用英语写出这个名字 安娜。Anna' });
    assert.equal(challengeSig(a), challengeSig(b));
    const c = dom({ promptText: '用英语写出这个名字 鲍勃。', boxText: '用英语写出这个名字 鲍勃。' });
    assert.notEqual(challengeSig(a), challengeSig(c), '真换了题干才算换题');
  });

  await t('DOM 读取失败不算成功：非课程路由也归 unknownRead', async () => {
    const page = {
      url: () => 'https://www.duolingo.com/lesson/unit/43/legendary/8',
      async evaluate() { throw new Error('Execution context was destroyed'); },
      locator() { return { async count() { return 0; }, async innerText() { return ''; }, async click() {} }; },
    };
    const r = await afterSubmit(page, dom(), { click: { clicked: 1, errors: [] } });
    assert.equal(r.status, 'unknownRead');
    assert.ok(/destroyed/.test(r.readErr), '要保留读取异常文本');
  });

  await t('读取失败但路由真的离开课程 → 才允许算 left', async () => {
    const page = {
      url: () => 'https://www.duolingo.com/learn',
      async evaluate() { throw new Error('frame detached'); },
      locator() { return { async count() { return 0; }, async innerText() { return ''; }, async click() {} }; },
    };
    const r = await afterSubmit(page, dom(), { click: { clicked: 1, errors: [] } });
    assert.equal(r.status, 'answered');
    assert.equal(r.evidence, 'left');
  });

  await t('「继续」页空点、页面没变化 → 不算进展', async () => {
    const page = {
      url: () => 'https://www.duolingo.com/lesson/unit/43/legendary/8',
      async evaluate() { return { type: 'name', options: [], hasInput: true, boxText: '用英语写出这个名字 安娜。', promptText: '用英语写出这个名字 安娜。' }; },
      locator() { return { async count() { return 1; }, async innerText() { return '继续'; }, async click() {} }; },
    };
    const same = dom({ options: [], promptText: '用英语写出这个名字 安娜。', boxText: '用英语写出这个名字 安娜。' });
    const r = await afterSubmit(page, same, { click: { clicked: 1, errors: [] }, continued: true, beforeFooter: '继续' });
    assert.equal(r.status, 'nochange');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exitCode = 1;
})();
