// 题目识别 / 答案计划 / 标注核心。浏览器入口和离线测试共用这一份实现。

const norm = (s) => (s || '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

function tx(x) {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') return x.text || x.value || x.word || '';
  return '';
}

// 同一份课程响应里的三组题池
function collectChallenges(session) {
  const out = [];
  const push = (arr, pool) => {
    if (!Array.isArray(arr)) return;
    for (const c of arr) if (c && c.id != null) out.push(Object.assign({}, c, { __pool: pool }));
  };
  push(session.challenges, 'main');
  push(session.mistakesReplacementChallenges, 'replacement');
  push(session.adaptiveChallenges, 'adaptive');                                  // 每日巩固/练习会话
  if (session.adaptiveInterleavedChallenges) push(session.adaptiveInterleavedChallenges.challenges, 'interleaved');
  return out;
}

// 该题在页面上会呈现的全部选项（含干扰项），匹配要用完整集合
function challengeOptions(ch) {
  const out = [];
  const add = (v) => { const t = tx(v); if (t) out.push(t); };
  // 只取“页面上的可选项”，不要把 displayTokens / tokens（整句与提示表）算进来
  if (Array.isArray(ch.choices) && ch.choices.length) { ch.choices.forEach(add); return out; }
  if (Array.isArray(ch.options) && ch.options.length) { ch.options.forEach(add); return out; }
  if (Array.isArray(ch.pairs) && ch.pairs.length) {
    ch.pairs.forEach((p) => { add(p.learningToken); add(p.fromToken); });
    return out;
  }
  if (Array.isArray(ch.correctTokens) && ch.correctTokens.length) {
    ch.correctTokens.forEach(add);
    if (Array.isArray(ch.wrongTokens)) ch.wrongTokens.forEach(add);
    return out;
  }
  return out;
}

// 正确答案计划：{ text, order }，order>0 表示要按顺序点
function buildPlan(ch) {
  if (Array.isArray(ch.pairs) && ch.pairs.length) {
    const plan = [];
    ch.pairs.forEach((p, i) => {
      plan.push({ text: p.learningToken, order: i + 1 });
      plan.push({ text: p.fromToken, order: i + 1 });
    });
    return plan.filter((p) => p.text);
  }
  if (Array.isArray(ch.correctTokens) && ch.correctTokens.length) {
    return ch.correctTokens.map((t, i) => ({ text: tx(t), order: i + 1 })).filter((p) => p.text);
  }
  const list = ch.choices || ch.options;
  let idx = ch.correctIndices;
  if (!Array.isArray(idx) && ch.correctIndex != null) idx = [ch.correctIndex];
  if (Array.isArray(list) && Array.isArray(idx)) {
    return idx
      .map((i, k) => ({ text: tx(list[i]), order: idx.length > 1 ? k + 1 : 0 }))
      .filter((p) => p.text);
  }
  return [];
}

// 题型别名：extendedMatch 是配对题的扩展版，答案结构相同
function normType(t) {
  return t === 'extendedMatch' ? 'match' : t;
}

function multiset(list) {
  const m = new Map();
  for (const x of list) { const k = norm(x); if (k) m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

function sameMultiset(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

// 输入框题的答案（可接受答案列表，取第一个即可）
function textAnswers(ch) {
  // 缺词填空（completeReverseTranslation）：displayTokens 里 isBlank 的片段就是答案
  if (Array.isArray(ch.displayTokens) && ch.displayTokens.length) {
    const blanks = ch.displayTokens
      .filter((t) => t && t.isBlank && typeof t.text === 'string')
      .map((t) => t.text)
      .join('');
    if (blanks.trim()) return [blanks];
  }
  if (Array.isArray(ch.correctSolutions) && ch.correctSolutions.length) {
    return ch.correctSolutions.filter((x) => typeof x === 'string' && x);
  }
  return [];
}

// 输入框题没有选项可比，只能用题干文本匹配（boxText 里包含题目的 prompt）
function matchByPrompt(pools, boxText, domType) {
  if (!boxText) return null;
  const base = pools.filter((p) => p.prompt && textAnswers(p).length && boxText.includes(p.prompt));
  // 传了页面题型就只在同题型里认：跨题型回退会把整句答案塞进缺词空位
  const cands = domType ? base.filter((p) => normType(p.type) === normType(domType)) : base;
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  // 短题干是长题干子串时会同时命中（"您用卡付吗？" ⊂ "对不起，先生，您用卡付吗？"），取最长的
  const longest = Math.max(...cands.map((p) => p.prompt.length));
  const best = cands.filter((p) => p.prompt.length === longest);
  const plans = new Set(best.map((p) => JSON.stringify(textAnswers(p))));
  return plans.size === 1 ? best[0] : null;
}

// 页面选项可能是题目选项的整数倍重复（多邻国渲染两套布局）
function multipleOf(dset, cset) {
  if (dset.size !== cset.size) return null;
  let k = null;
  for (const [key, v] of cset) {
    const av = dset.get(key);
    if (av == null || av % v !== 0) return null;
    const kk = av / v;
    if (k === null) k = kk; else if (k !== kk) return null;
  }
  return k && k >= 1 ? k : null;
}

// 严格匹配：页面完整选项多重集必须与某题完全一致。
// 不唯一时只在“答案是同一个”时才接受，否则返回 null（明确未识别，禁止猜）。
function matchChallenge(pools, domOptions, domType) {
  if (!Array.isArray(domOptions) || !domOptions.length) return null;
  const dset = multiset(domOptions);
  let hits = pools.filter((ch) => sameMultiset(dset, multiset(challengeOptions(ch))));
  if (!hits.length) hits = pools.filter((ch) => multipleOf(dset, multiset(challengeOptions(ch))) !== null);
  // 题型必须一致：过滤后为空就是不匹配，不能回退到其他题型
  if (domType) hits = hits.filter((ch) => normType(ch.type) === normType(domType));
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0];
  const sigs = new Set(hits.map((ch) => JSON.stringify(buildPlan(ch))));
  return sigs.size === 1 ? hits[0] : null;
}


// 把答案计划分配到页面选项：优先完整文本相等，重复词按顺序占用，绝不子串误配
function assignMarks(optionTexts, plan) {
  const opts = optionTexts.map(norm);
  // 多邻国用 "手机1" 表示第二个「手机」，这里只做“去掉尾部数字后相等”的显式兼容
  const optsStripped = optionTexts.map((t) => norm((t || '').replace(/\d+$/, '')));
  const used = new Set();
  const out = [];
  for (const p of plan) {
    const t = norm(p.text || '');
    if (!t) continue;
    // 只做完整相等；不做任意子串兜底（"the" 绝不能命中 "theater"）
    let idx = opts.findIndex((o, i) => !used.has(i) && o === t);
    if (idx < 0) idx = optsStripped.findIndex((o, i) => !used.has(i) && o === t);
    if (idx < 0) continue;
    used.add(idx);
    out.push({ index: idx, order: p.order || 0, text: p.text });
  }
  return out;
}

// DOM 选项（可能已被点掉一部分）是否仍属于该题的选项
function isSubsetOf(domOptions, chOptions) {
  const d = multiset(domOptions);
  const o = multiset(chOptions);
  for (const [k, v] of d) if ((o.get(k) || 0) < v) return false;
  return true;
}

// 严格匹配优先；失败时仅当“选项被点掉的唯一超集”才接受。空选项/不唯一一律 null。
function resolveChallenge(pools, dom) {
  if (!dom || !Array.isArray(dom.options) || !dom.options.length) return null;
  let strict = matchChallenge(pools, dom.options, dom.type);
  if (!strict) {
    // 重复词块会带数字后缀（city3 = 第三个 city），去掉尾数字再匹配一次
    const stripped = dom.options.map((t) => (t || '').replace(/\d+$/, '').trim());
    if (JSON.stringify(stripped) !== JSON.stringify(dom.options)) {
      strict = matchChallenge(pools, stripped, dom.type);
    }
  }
  if (!strict) {
    // 仍失败：DOM 把重复词展开成多个按钮（开始 / 开始3），去重后与 choices 比较
    const uniq = [...new Set(dom.options.map((t) => (t || '').replace(/\d+$/, '').trim()).filter(Boolean))];
    if (uniq.length < dom.options.length) strict = matchChallenge(pools, uniq, dom.type);
  }
  if (strict) return strict;
  // 子集匹配也要先去掉数字后缀（配对题词块带 1-5 后缀，且页面可能只显示部分词）
  const domNorm = [...new Set(dom.options.map((t) => (t || '').replace(/\d+$/, '').trim()).filter(Boolean))];
  let cands = pools.filter((p) => normType(p.type) === normType(dom.type) && isSubsetOf(domNorm, challengeOptions(p)));
  if (!cands.length) return null;
  // lexemes 是全量词表，只做兜底：有 session 题命中时优先用它
  if (cands.length > 1) {
    const sessionOnly = cands.filter((p) => p.__pool !== 'lexemes');
    if (sessionOnly.length) cands = sessionOnly;
  }
  const plans = new Set(cands.map((p) => JSON.stringify(buildPlan(p))));
  return plans.size === 1 ? cands[0] : null;
}

// 故事课（stories.duolingo.com/api2/stories）的答案计划
// MULTIPLE_CHOICE: correctAnswerIndex + answers[].text
// ARRANGE: phraseOrder 是 selectablePhrases 的下标序列
// GAP_FILL: correctIndices + choices
// POINT_TO_PHRASE: correctAnswerIndex 指向 selectable 片段
function storiesPlan(el) {
  if (!el || !el.type) return [];
  if (el.type === 'MULTIPLE_CHOICE' || el.type === 'SELECT_PHRASE') {
    const a = (el.answers || [])[el.correctAnswerIndex];
    return a ? [{ text: tx(a), order: 0 }] : [];
  }
  if (el.type === 'ARRANGE') {
    return (el.phraseOrder || []).map((i) => ({ text: (el.selectablePhrases || [])[i], order: 0 })).filter((p) => p.text);
  }
  if (el.type === 'GAP_FILL') {
    return (el.correctIndices || []).map((i) => ({ text: (el.choices || [])[i], order: 0 })).filter((p) => p.text);
  }
  if (el.type === 'POINT_TO_PHRASE') {
    const parts = (el.transcriptParts || []).filter((p) => p.selectable);
    const a = parts[el.correctAnswerIndex];
    return a ? [{ text: a.text, order: 0 }] : [];
  }
  if (el.type === 'MATCH') {
    return (el.matches || []).flatMap((p, i) => [
      { text: p.phrase, order: i + 1 }, { text: p.translation, order: i + 1 },
    ]).filter((p) => p.text);
  }
  return [];
}

// 故事课元素里，能在页面上找到对应控件的那些题型
function storiesQuestions(session) {
  if (!session || !Array.isArray(session.elements)) return [];
  return session.elements.filter((e) => ['MULTIPLE_CHOICE', 'ARRANGE', 'GAP_FILL', 'POINT_TO_PHRASE', 'SELECT_PHRASE', 'MATCH'].includes(e.type));
}

// 输入框题的题干可能是英文句子（缺词填空），用 displayTokens 的非空文本匹配
function matchByDisplay(pools, boxText, domType) {
  const norm = (s) => (s || '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
  const box = norm(boxText);
  if (!box) return null;
  const cands = [];
  for (const p of pools) {
    // 传了页面题型就只认同题型：填空/缺词这些题靠句子认，跨题型容易撞到别的题
    if (domType && normType(p.type) !== normType(domType)) continue;
    const dt = p.displayTokens || [];
    if (!dt.length) continue;
    const known = norm(dt.filter((t) => !t.isBlank).map((t) => t.text).join(' '));
    if (!known) continue;
    // 已知部分必须基本都出现在页面题干里
    const words = known.split(' ').filter((w) => w.length > 1);
    if (!words.length) continue;
    const hit = words.filter((w) => box.includes(w)).length;
    if (hit / words.length >= 0.8) cands.push(p);
  }
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  const plans = new Set(cands.map((p) => JSON.stringify(textAnswers(p))));
  return plans.size === 1 ? cands[0] : null;
}

// 词汇配对练习：答案来自 practice-lexemes（word ↔ translation），不在 session 里
function challengeFromLexemes(lexemes, domOptions) {
  // 只保留页面实际出现的词对，否则会对着不存在的词空点
  const want = new Set((domOptions || []).map((t) => norm((t || '').replace(/\d+$/, '').trim())).filter(Boolean));
  const pairs = (lexemes || [])
    .filter((x) => x && x.word && x.translation)
    .filter((x) => !want.size || (want.has(norm(x.word)) && want.has(norm(x.translation))))
    .map((x) => ({ learningToken: x.word, fromToken: x.translation }));
  if (!pairs.length) return null;
  return { id: 'lexemes|' + pairs.length, type: 'match', pairs, __pool: 'lexemes' };
}

module.exports = { challengeFromLexemes,  normType, matchByDisplay,  storiesPlan, storiesQuestions,  resolveChallenge, textAnswers, matchByPrompt,  isSubsetOf,  norm, tx, collectChallenges, challengeOptions, buildPlan, matchChallenge, multiset, sameMultiset, assignMarks, multipleOf };
