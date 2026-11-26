// 回归：tapComplete 同选项不同答案、页面是两句拼接时，连续短语匹配能区分（s3u84l4 真实数据）
const assert = require('node:assert/strict');
const c = require('./core.js');

// blank token 的 text 就是答案片段（与真实 session 一致：ans = blank 拼接）
const mainCand = {
  id: 'main', type: 'tapComplete',
  displayTokens: [
    { text: 'Mon', isBlank: false }, { text: ' ', isBlank: false }, { text: 'frère', isBlank: false },
    { text: ' ', isBlank: false }, { text: 'lui', isBlank: true }, { text: ' ', isBlank: false },
    { text: 'parle', isBlank: false }, { text: ' ? À ', isBlank: false }, { text: 'qui', isBlank: false },
    { text: ' ? ', isBlank: false }, { text: 'Mon', isBlank: false }, { text: ' ', isBlank: false },
    { text: 'frère', isBlank: false }, { text: ' ', isBlank: false }, { text: 'parle', isBlank: false },
    { text: ' ', isBlank: false }, { text: 'à notre chien', isBlank: true }, { text: ' ', isBlank: false },
    { text: 'bien', isBlank: false }, { text: ' ', isBlank: false }, { text: 'sûr', isBlank: false },
    { text: ' !', isBlank: false },
  ],
  choices: ['à notre chien', 'lui'], correctIndices: [1, 0],
};
const otherCand = {
  id: 'other', type: 'tapComplete',
  displayTokens: [
    { text: 'Mon', isBlank: false }, { text: ' ', isBlank: false }, { text: 'frère', isBlank: false },
    { text: ' ', isBlank: false }, { text: 'parle', isBlank: false }, { text: ' . ', isBlank: false },
    { text: 'Mon', isBlank: false }, { text: ' ', isBlank: false }, { text: 'frère', isBlank: false },
    { text: ' ', isBlank: false }, { text: 'à notre chien', isBlank: true }, { text: ' ', isBlank: false },
    { text: 'parle', isBlank: false }, { text: ' .', isBlank: false },
  ],
  choices: ['lui', 'à notre chien'], correctIndices: [0, 1],
};
const boxText = '填空\nMon\n frère\n \n parle\n ? À\n qui\n ? Mon\n frère\n parle\n \n bien\n sûr\n !\nà notre chien\nlui';

const t = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '：' + e.message.slice(0, 300)); process.exitCode = 1; }
};

t('连续短语匹配命中页面那句话的候选', () => {
  assert.equal(c.matchByDisplayStrict([mainCand, otherCand], boxText, 'tapComplete'), mainCand);
});

t('旧的 80% 覆盖匹配对这道题仍歧义（返回 null）', () => {
  assert.equal(c.matchByDisplay([mainCand, otherCand], boxText, 'tapComplete'), null);
});

t('两条句子相同、答案计划不同：拒绝', () => {
  const twin = { ...mainCand, id: 'twin', choices: ['lui', 'à notre chien'], correctIndices: [1, 0] };
  assert.equal(c.matchByDisplayStrict([mainCand, twin], boxText, 'tapComplete'), null);
});

t('跨题型不命中', () => {
  assert.equal(c.matchByDisplayStrict([mainCand], boxText, 'gapFill'), null);
});

t('已知词不足 3 个：不做判断', () => {
  const tiny = { type: 'tapComplete', displayTokens: [{ text: 'Mon', isBlank: false }], choices: ['x'], correctIndices: [0] };
  assert.equal(c.matchByDisplayStrict([tiny], boxText, 'tapComplete'), null);
});

console.log(process.exitCode ? 'tapComplete 连续短语测试失败' : '所有 tapComplete 连续短语测试通过 ✓');
