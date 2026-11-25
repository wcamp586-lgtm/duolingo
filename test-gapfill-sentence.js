// gapFill 句子匹配回归：数据来自 2026-11-24 s3u81l4 真实取证
// （两条 gapFill 选项集相同、答案 étais/était，页面句子是「Tu _ la plus jeune dans ta famille ?」）。
const assert = require('node:assert/strict');
const { matchBySentence, challengeWordSequence } = require('./core.js');

const mainCandidate = {
  id: 'main', type: 'gapFill',
  displayTokens: [
    { text: 'Tu', isBlank: false }, { text: ' ', isBlank: false }, { text: 'étais', isBlank: true },
    { text: ' ', isBlank: false }, { text: 'la', isBlank: false }, { text: ' ', isBlank: false },
    { text: 'plus', isBlank: false }, { text: ' ', isBlank: false }, { text: 'jeune', isBlank: false },
    { text: ' ', isBlank: false }, { text: 'dans', isBlank: false }, { text: ' ', isBlank: false },
    { text: 'ta', isBlank: false }, { text: ' ', isBlank: false }, { text: 'famille', isBlank: false },
    { text: ' ', isBlank: false }, { text: '?', isBlank: false },
  ],
  choices: ['être', 'était', 'étais'],
  correctIndex: 2,
};

const interleavedCandidate = {
  id: 'interleaved', type: 'gapFill',
  displayTokens: [
    { text: 'Omar', isBlank: false }, { text: ' ', isBlank: false }, { text: 'était', isBlank: true },
    { text: ' ', isBlank: false }, { text: 'le', isBlank: false }, { text: ' ', isBlank: false },
    { text: 'plus', isBlank: false }, { text: ' ', isBlank: false }, { text: 'jeune', isBlank: false },
    { text: ' ', isBlank: false }, { text: 'dans', isBlank: false }, { text: ' ', isBlank: false },
    { text: 'la', isBlank: false }, { text: ' ', isBlank: false }, { text: 'famille', isBlank: false },
    { text: ' ', isBlank: false }, { text: '.', isBlank: false },
  ],
  choices: ['être', 'étais', 'était'],
  correctIndex: 2,
};

// 页面 boxText 与失败日志一致（选项顺序会被平台打乱，匹配不应依赖它）
const pageDom = {
  type: 'gapFill',
  boxText: '填空\nTu\n \n la\n plus\n jeune\n dans\n ta\n famille\n ?\n1\nétait\n2\nêtre\n3\nétais',
};

const t = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '：' + e.message); process.exitCode = 1; }
};

t('challengeWordSequence 取非空格词（blank 词不算进句子）', () => {
  const words = challengeWordSequence(mainCandidate);
  assert.deepEqual(words, ['tu', 'la', 'plus', 'jeune', 'dans', 'ta', 'famille']);
});

t('两句不同：命中页面那句话（main / étais）', () => {
  const hit = matchBySentence([mainCandidate, interleavedCandidate], pageDom, 'gapFill');
  assert.equal(hit, mainCandidate);
});

t('两句相同、仅答案不同：拒绝而不是猜', () => {
  const same = { ...interleavedCandidate, displayTokens: mainCandidate.displayTokens };
  assert.equal(matchBySentence([mainCandidate, same], pageDom, 'gapFill'), null);
});

t('单条候选：命中', () => {
  assert.equal(matchBySentence([mainCandidate], pageDom, 'gapFill'), mainCandidate);
});

t('无 displayTokens / 无 metadata：返回 null', () => {
  const noDt = { type: 'gapFill', choices: ['être', 'était', 'étais'], correctIndex: 2 };
  assert.equal(matchBySentence([noDt], pageDom, 'gapFill'), null);
});

t('跨题型不命中（gapFill 候选不能冒充 tapComplete）', () => {
  assert.equal(matchBySentence([mainCandidate], pageDom, 'tapComplete'), null);
});

t('metadata.prompt 兜底：displayTokens 缺失时也能认（句子不含答案词）', () => {
  const onlyMeta = {
    type: 'gapFill',
    metadata: { prompt: 'Tu la plus jeune dans ta famille ?' },
    choices: ['être', 'était', 'étais'], correctIndex: 2,
  };
  assert.equal(matchBySentence([onlyMeta], pageDom, 'gapFill'), onlyMeta);
});

t('页面完全不含候选句子：返回 null', () => {
  const other = { type: 'gapFill', displayTokens: [
    { text: 'Nous', isBlank: false }, { text: ' ', isBlank: false }, { text: 'mangeons', isBlank: true },
    { text: ' ', isBlank: false }, { text: 'ensemble', isBlank: false },
  ], choices: ['mangeons'], correctIndex: 0 };
  assert.equal(matchBySentence([other], pageDom, 'gapFill'), null);
});

console.log(process.exitCode ? 'gapFill 句子匹配测试失败' : '所有 gapFill 句子匹配测试通过 ✓');
