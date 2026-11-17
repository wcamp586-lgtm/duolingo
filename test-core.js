// 离线验证 core.js：不打开浏览器、不联网。
const assert = require('assert');
const c = require('./core.js');
const session = require('./session-en.json');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + ' -> ' + e.message); } };

console.log('\n[1] 三题池合并');
t('合并后数量 = 17+17+8', () => {
  const pools = c.collectChallenges(session);
  assert.strictEqual(pools.length, 17 + 17 + 8);
});
t('adaptiveChallenges 也会被合并（每日巩固会话）', () => {
  const s = { challenges: [{ id: 'a', type: 'translate', choices: ['x'], correctIndices: [0] }],
              adaptiveChallenges: [{ id: 'b', type: 'translate', choices: ['y'], correctIndices: [0] }] };
  const p = c.collectChallenges(s);
  assert.strictEqual(p.length, 2);
  assert.ok(p.some((x) => x.__pool === 'adaptive'));
});
t('池标记齐全', () => {
  const pools = c.collectChallenges(session);
  const by = {};
  pools.forEach((p) => { by[p.__pool] = (by[p.__pool] || 0) + 1; });
  assert.deepStrictEqual(by, { main: 17, replacement: 17, interleaved: 8 });
});

console.log('\n[2] 严格匹配：必须用完整选项集合');
const pools = c.collectChallenges(session);
const dialogue = pools.find((x) => x.type === 'dialogue');
t('dialogue（无词块）能匹配到', () => {
  const opts = c.challengeOptions(dialogue);
  const m = c.matchChallenge(pools, opts);
  assert.ok(m, '应匹配');
});
t('只给正确答案（丢干扰项）匹配失败，不猜', () => {
  const plan = c.buildPlan(dialogue);
  const onlyAnswers = plan.map((p) => p.text);
  const m = c.matchChallenge(pools, onlyAnswers);
  assert.strictEqual(m, null);
});
t('完全不同选项返回 null', () => {
  assert.strictEqual(c.matchChallenge(pools, ['zzz', 'qqq']), null);
});
t('空选项返回 null', () => {
  assert.strictEqual(c.matchChallenge(pools, []), null);
});

console.log('\n[3] 每道题用自身完整选项都能匹配回自己（或同答案题）');
t('17 主池 + 17 替换池逐题匹配不报错且答案一致', () => {
  let ok = 0, bad = [];
  for (const ch of pools) {
    if (ch.type === 'speak') continue;
    const opts = c.challengeOptions(ch);
    const m = c.matchChallenge(pools, opts);
    if (!m) { bad.push(ch.type + ':' + ch.id.slice(0, 6)); continue; }
    const a = JSON.stringify(c.buildPlan(ch));
    const b = JSON.stringify(c.buildPlan(m));
    if (a === b) ok++; else bad.push(ch.type + ':答案不一致');
  }
  assert.deepStrictEqual(bad, [], '问题项: ' + bad.join(', '));
});

console.log('\n[4] 标注分配：诊断报告的 Japan/a 错标场景');
t('["Japan","a"] 答案 a → 标 a（index 1）', () => {
  const r = c.assignMarks(['Japan', 'a'], [{ text: 'a', order: 0 }]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].index, 1);
});
t('重复词按顺序占用，不重复标同一个按钮', () => {
  const r = c.assignMarks(['the', 'the', 'cat'], [{ text: 'the', order: 1 }, { text: 'cat', order: 2 }]);
  assert.deepStrictEqual(r.map((x) => x.index), [0, 2]);
});
t('"the" 不会命中 "theater"（严格相等，不再子串兜底）', () => {
  const r = c.assignMarks(['theater'], [{ text: 'the', order: 1 }]);
  assert.strictEqual(r.length, 0, '完整不相等时必须不标');
});
t('"the"/"theater" 并存时命中前者', () => {
  const r = c.assignMarks(['the', 'theater'], [{ text: 'the', order: 1 }]);
  assert.strictEqual(r[0].index, 0);
});
t('数字后缀显式兼容：手机1 → 手机', () => {
  const r = c.assignMarks(['手机1', '是'], [{ text: '手机', order: 1 }]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].index, 0);
});

console.log('\n[5] 答案计划覆盖题型');
t('dialogue / listenIsolation 用 correctIndex 生成计划', () => {
  const d = pools.find((x) => x.type === 'dialogue');
  const p = c.buildPlan(d);
  assert.ok(p.length >= 1 && p[0].text);
});
t('listenIsolation 用 options[correctIndex]', () => {
  const l = pools.find((x) => x.type === 'listenIsolation');
  if (!l) return;
  const p = c.buildPlan(l);
  assert.ok(p.length >= 1 && p[0].text);
});


console.log('\n[6] 换题判断（空选项/不唯一不得沿用）');
t('空选项返回 null（口语题不会被当成上一题）', () => {
  assert.strictEqual(c.resolveChallenge(pools, { type: 'speak', options: [] }), null);
});
t('缺 options 返回 null', () => {
  assert.strictEqual(c.resolveChallenge(pools, { type: 'translate' }), null);
});
t('两题同选项不同答案 -> null（不猜）', () => {
  const fake = [
    { id: 'x1', type: 'dialogue', choices: ['yes', 'no'], correctIndex: 0 },
    { id: 'x2', type: 'dialogue', choices: ['yes', 'no'], correctIndex: 1 },
  ];
  assert.strictEqual(c.resolveChallenge(fake, { type: 'dialogue', options: ['yes', 'no'] }), null);
});
t('选项被点掉一部分但答案唯一 -> 接受', () => {
  const dl = pools.find((x) => x.type === 'dialogue');
  const full = c.challengeOptions(dl);
  const partial = full.slice(0, 1);
  const m = c.resolveChallenge(pools, { type: 'dialogue', options: partial });
  assert.ok(m, '应接受唯一超集');
});
t('题型不符 -> null', () => {
  const dl = pools.find((x) => x.type === 'dialogue');
  assert.strictEqual(c.resolveChallenge(pools, { type: 'speak', options: c.challengeOptions(dl) }), null);
});


t('选项带数字后缀也能匹配（city3 → city）', () => {
  const fake = [{ id: 'z1', type: 'translate', choices: ['city', 'nice'], correctIndices: [0] }];
  const m = c.resolveChallenge(fake, { type: 'translate', options: ['city3', 'nice'] });
  assert.ok(m, '应匹配');
  assert.strictEqual(c.buildPlan(m)[0].text, 'city');
});


console.log('\n[7] 输入框题（打字）');
t('按题干匹配并给出 correctSolutions', () => {
  const fake = [{ id: 't1', type: 'translate', prompt: '这座图书馆非常旧。', correctSolutions: ['this library is very old'] }];
  const m = c.matchByPrompt(fake, '用英语写出这句话 这座图书馆非常旧。');
  assert.ok(m);
  assert.strictEqual(c.textAnswers(m)[0], 'this library is very old');
});
t('题干不匹配 -> null', () => {
  const fake = [{ id: 't1', type: 'translate', prompt: '这座图书馆非常旧。', correctSolutions: ['x'] }];
  assert.strictEqual(c.matchByPrompt(fake, '完全不同的句子'), null);
});
t('多个题干命中但答案不同 -> null', () => {
  const fake = [
    { id: 'a', type: 'translate', prompt: '你好', correctSolutions: ['hi'] },
    { id: 'b', type: 'translate', prompt: '你好', correctSolutions: ['hello'] },
  ];
  assert.strictEqual(c.matchByPrompt(fake, '用英语写 你好'), null);
});
t('短题干是长题干子串时取最长的（法语真实案例）', () => {
  const fake = [
    { id: 'a', type: 'translate', prompt: '您用卡付吗？', correctSolutions: ['Vous payez par carte ?'] },
    { id: 'b', type: 'translate', prompt: '对不起，先生，您用卡付吗？', correctSolutions: ['Excusez-moi Monsieur, vous payez par carte ?'] },
  ];
  const m = c.matchByPrompt(fake, '用法语写出这句话 对不起，先生，您用卡付吗？');
  assert.ok(m);
  assert.strictEqual(m.id, 'b');
});
t('select 题：选项是 {phrase} 对象（普通课新题型）', () => {
  const ch = {
    type: 'select', prompt: '哪个是“茶”呢？', correctIndex: 0,
    choices: [{ phrase: 'Tee' }, { phrase: 'Kaffee' }, { phrase: 'Zucker' }],
  };
  assert.deepStrictEqual(c.challengeOptions(ch), ['Tee', 'Kaffee', 'Zucker']);
  // 页面选项带键盘快捷键尾号（Tee1 / Kaffee2），要能对上
  const plan = c.buildPlan(ch);
  assert.deepStrictEqual(c.assignMarks(['Tee1', 'Kaffee2', 'Zucker3'], plan), [{ index: 0, order: 0, text: 'Tee' }]);
});
t('普通课 match：同词表不同顺序也能认（无序配对）', () => {
  const mk = (pairs) => ({ id: pairs.map((p) => p[0]).join(), type: 'match', pairs: pairs.map((p) => ({ learningToken: p[0], fromToken: p[1] })) });
  const a = mk([['咖啡', 'Kaffee'], ['请', 'bitte'], ['你好', 'hallo'], ['茶', 'Tee']]);
  const b = mk([['茶', 'Tee'], ['你好', 'hallo'], ['请', 'bitte'], ['咖啡', 'Kaffee']]);
  const hit = c.resolveChallenge([a, b], { type: 'match', options: ['咖啡', '请', '你好', '茶', 'Kaffee', 'bitte', 'hallo', 'Tee'] });
  assert.ok(hit, '同词表应命中');
  assert.strictEqual(c.planSig(hit), c.planSig(a));
});
t('无 correctSolutions 的题不参与匹配', () => {
  const fake = [{ id: 'a', type: 'translate', prompt: '你好', correctSolutions: [] }];
  assert.strictEqual(c.matchByPrompt(fake, '你好'), null);
});


t('缺词填空：displayTokens 的 isBlank 片段', () => {
  const ch = { displayTokens: [
    { text: 'This', isBlank: false }, { text: ' ', isBlank: false },
    { text: 'park', isBlank: true }, { text: ' ', isBlank: false }, { text: 'is', isBlank: false },
  ] };
  assert.deepStrictEqual(c.textAnswers(ch), ['park']);
});
t('缺词在句末（your 那题）', () => {
  const ch = { displayTokens: [
    { text: ' ', isBlank: false }, { text: 'street', isBlank: false }, { text: ' is quiet, right?', isBlank: false },
  ], prompt: '你那条街很安静，对吧？' };
  // 没有 isBlank 时不应产生假答案
  assert.deepStrictEqual(c.textAnswers(ch), []);
});


t('重复词展开（开始/开始3）去重后能匹配', () => {
  const fake = [{ id: 'r1', type: 'translate', choices: ['我', '应该', '开始', '写日记'], correctIndices: [0, 1, 2, 3] }];
  const dom = ['我', '应该', '开始', '写日记', '开始3', '我1'];
  const m = c.resolveChallenge(fake, { type: 'translate', options: dom });
  assert.ok(m, '去重后应匹配');
  assert.strictEqual(c.buildPlan(m).length, 4);
});


console.log('\n[8] 故事课题型');
t('MULTIPLE_CHOICE 取 correctAnswerIndex', () => {
  const el = { type: 'MULTIPLE_CHOICE', answers: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], correctAnswerIndex: 1 };
  assert.deepStrictEqual(c.storiesPlan(el).map((x) => x.text), ['b']);
});
t('ARRANGE 按 phraseOrder 排序', () => {
  const el = { type: 'ARRANGE', selectablePhrases: ['look', 'How', 'does', 'it'], phraseOrder: [1, 2, 3, 0] };
  assert.deepStrictEqual(c.storiesPlan(el).map((x) => x.text), ['How', 'does', 'it', 'look']);
});
t('GAP_FILL 取 correctIndices', () => {
  const el = { type: 'GAP_FILL', choices: ['finished', 'cold', 'great', 'early'], correctIndices: [0, 2] };
  assert.deepStrictEqual(c.storiesPlan(el).map((x) => x.text), ['finished', 'great']);
});
t('POINT_TO_PHRASE 取 selectable[correctAnswerIndex]', () => {
  const el = { type: 'POINT_TO_PHRASE', transcriptParts: [{ text: 'A', selectable: true }, { text: '.', selectable: false }, { text: 'B', selectable: true }], correctAnswerIndex: 1 };
  assert.deepStrictEqual(c.storiesPlan(el).map((x) => x.text), ['B']);
});
t('storiesQuestions 过滤出可作答元素', () => {
  const s = { elements: [{ type: 'LINE' }, { type: 'MULTIPLE_CHOICE' }, { type: 'HEADER' }, { type: 'GAP_FILL' }] };
  assert.strictEqual(c.storiesQuestions(s).length, 2);
});


t('英文题干的缺词填空用 displayTokens 匹配', () => {
  const fake = [{
    id: 'd1', type: 'completeReverseTranslation', prompt: '我和妈妈分享一个特别的东西。',
    displayTokens: [{ text: 'My', isBlank: false }, { text: ' ', isBlank: false }, { text: 'mom', isBlank: false },
      { text: ' ', isBlank: false }, { text: 'and', isBlank: false }, { text: ' ', isBlank: false },
      { text: 'I', isBlank: false }, { text: ' ', isBlank: false }, { text: 'share', isBlank: false },
      { text: ' ', isBlank: false }, { text: 'a', isBlank: false }, { text: ' ', isBlank: false },
      { text: 'special', isBlank: false }, { text: ' ', isBlank: false }, { text: 'bond', isBlank: true }],
  }];
  const m = c.matchByDisplay(fake, '输入所缺单词 My mom and I share a special bo .');
  assert.ok(m, '应匹配');
  assert.deepStrictEqual(c.textAnswers(m)[0], 'bond');
});
t('题干完全不符 -> null', () => {
  const fake = [{ id: 'd2', type: 'completeReverseTranslation', displayTokens: [{ text: 'Zebra', isBlank: false }] }];
  assert.strictEqual(c.matchByDisplay(fake, 'completely different sentence'), null);
});


t('配对题：页面只显示部分词且带后缀，仍能匹配', () => {
  const fake = [{ id: 'm1', type: 'match', pairs: [
    { learningToken: 'higher education', fromToken: '高等教育' },
    { learningToken: 'lifelong', fromToken: '一辈子的' },
    { learningToken: 'wishing you', fromToken: '祝你' },
    { learningToken: 'dedication', fromToken: '奉献' },
    { learningToken: 'all worth it', fromToken: '值得' },
  ] }];
  const dom = ['奉献4','祝你3','一辈子的2','值得5','高等教育1','lifelong2','wishing you3','dedication4'];
  const m = c.resolveChallenge(fake, { type: 'match', options: dom });
  assert.ok(m, '应匹配');
});


t('extendedMatch 按 match 匹配', () => {
  const fake = [{ id: 'e1', type: 'match', pairs: [
    { learningToken: 'sing', fromToken: '唱过' },
    { learningToken: 'colleague', fromToken: '同志' },
  ] }];
  const m = c.resolveChallenge(fake, { type: 'extendedMatch', options: ['唱过', 'sing', '同志', 'colleague'] });
  assert.ok(m, '应匹配');
});


t('词汇配对：从 practice-lexemes 构造并匹配', () => {
  const lex = [{ word: 'dedication', translation: '奉献' }, { word: 'trash can', translation: '垃圾桶' }, { word: 'young', translation: '年轻' }];
  const ch = c.challengeFromLexemes(lex);
  assert.ok(ch);
  assert.strictEqual(ch.pairs.length, 3);
  const m = c.resolveChallenge([ch], { type: 'extendedMatch', options: ['奉献', 'dedication', '垃圾桶', 'trash can'] });
  assert.ok(m, '应匹配');
});


t('session 题与 lexemes 同时命中时优先 session', () => {
  const sess = { id: 's1', type: 'match', __pool: 'main', pairs: [
    { learningToken: 'dedication', fromToken: '奉献' }, { learningToken: 'young', fromToken: '年轻' },
  ] };
  const lex = c.challengeFromLexemes([
    { word: 'dedication', translation: '奉献' }, { word: 'young', translation: '年轻' }, { word: 'other', translation: '其他' },
  ]);
  const m = c.resolveChallenge([sess, lex], { type: 'match', options: ['奉献', 'dedication'] });
  assert.ok(m);
  assert.strictEqual(m.__pool, 'main', '应优先 session');
});


t('词汇配对只保留页面出现的词对', () => {
  const lex = [
    { word: 'dedication', translation: '奉献' },
    { word: 'young', translation: '年轻' },
    { word: 'other', translation: '其他' },
  ];
  const ch = c.challengeFromLexemes(lex, ['奉献', 'dedication']);
  assert.strictEqual(ch.pairs.length, 1, '只应有 1 对');
  assert.strictEqual(ch.pairs[0].learningToken, 'dedication');
});


t('词对必须两边都在页面才保留（防止用上一题残留词）', () => {
  const lex = [
    { word: 'dedication', translation: '奉献' },
    { word: 'spooky', translation: '阴森可怕的' },
    { word: 'no', translation: '不对' },
  ];
  // 页面只剩 no/不对（dedication 已被配掉）
  const ch = c.challengeFromLexemes(lex, ['no', '不对']);
  assert.strictEqual(ch.pairs.length, 1);
  assert.strictEqual(ch.pairs[0].learningToken, 'no');
});

t('同题干两种题型时按页面题型选（整句翻译 vs 缺词填空）', () => {
  const box = '用英语写出这句话\n今天多云吗？';
  const pools = [
    { id: 'a', type: 'translate', prompt: '今天多云吗？', correctSolutions: ['Is it cloudy today?'] },
    { id: 'b', type: 'partialReverseTranslate', prompt: '今天多云吗？', correctSolutions: ['cloudy today'] },
  ];
  assert.strictEqual(c.matchByPrompt(pools, box), null, '不传题型时应仍返回 null（不猜）');
  const hit = c.matchByPrompt(pools, box, 'translate');
  assert.ok(hit && hit.id === 'a', '应选中整句翻译');
});

t('页面题型在池子里没有对应记录时不做跨题型回退', () => {
  const box = '输入所缺单词\n今天多云吗？';
  const pools = [
    { id: 'a', type: 'translate', prompt: '今天多云吗？', correctSolutions: ['Is it cloudy today?'] },
  ];
  // 只有整句翻译记录，页面却是缺词填空：整句答案塞不进单词空位，必须返回未识别
  assert.strictEqual(c.matchByPrompt(pools, box, 'partialReverseTranslate'), null);
  assert.ok(c.matchByPrompt(pools, box, 'translate'), '同题型仍应命中');
});

t('填空题按句子里的已知词认题（选项重复也能区分）', () => {
  const pools = [
    { id: 'a', type: 'tapComplete', displayTokens: [
      { text: 'He', isBlank: false }, { text: ' plays tennis ', isBlank: false },
      { text: 'at', isBlank: true }, { text: " two o'clock ", isBlank: false },
      { text: 'on', isBlank: true }, { text: ' Tuesdays.', isBlank: false } ],
      correctIndices: [0, 1], choices: ['on', 'at'] },
    { id: 'b', type: 'tapComplete', displayTokens: [
      { text: 'She', isBlank: false }, { text: ' plays ', isBlank: false },
      { text: 'at', isBlank: true }, { text: ' home.', isBlank: false } ],
      correctIndices: [0], choices: ['on', 'at'] },
  ];
  const box = "填空\nHe plays tennis  two o'clock  Tuesdays.\non\nat";
  const hit = c.matchByDisplay(pools, box, 'tapComplete');
  assert.ok(hit && hit.id === 'a', '应认出 He plays tennis 那题');
});

t('display 匹配传了题型就只认同题型', () => {
  const pools = [
    { id: 'x', type: 'tapComplete', displayTokens: [{ text: 'He plays tennis', isBlank: false }, { text: 'at', isBlank: true }], correctIndices: [0], choices: ['at'] },
    { id: 'y', type: 'translate', displayTokens: [{ text: 'He plays tennis', isBlank: false }, { text: 'at', isBlank: true }], correctSolutions: ['他在打网球'] },
  ];
  const hit = c.matchByDisplay(pools, 'He plays tennis at', 'translate');
  assert.ok(hit && hit.id === 'y', '只应返回 translate 那道');
});

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
