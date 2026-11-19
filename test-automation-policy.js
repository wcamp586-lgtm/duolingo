const assert=require('node:assert/strict');
const policy=require('./automation-policy.js');
const { parseLegendaryEntry, findCourseLevel } = require('./legendary-entry.js');
let passed=0;
function test(name,fn){fn();passed++;console.log('  ✓ '+name);}
test('completed legendary skill and story are skipped',()=>{
  for(const type of ['skill','story'])assert.equal(policy.classifyLevel({type,state:'legendary'}),'already-legendary');
});
test('only passed ordinary and story nodes are considered',()=>{
  for(const type of ['skill','story','practice','unit_review'])assert.equal(policy.classifyLevel({type,state:'passed'}),'check-legendary-entry');
  // 电台/AI对话和宝箱不是题目，仍然不刷
  for(const type of ['duo_radio','chest'])assert.equal(policy.classifyLevel({type,state:'passed'}),'derived-or-nontarget');
});
test('locked and unfinished nodes are not opened',()=>{
  for(const state of ['active','locked','unknown'])assert.equal(policy.classifyLevel({type:'skill',state}),'not-ready');
});
test('path ordering and identities survive duplicate display names',()=>{
  const result=policy.planCourse({id:'en',pathSectioned:[{index:0,type:'learning',units:[{unitIndex:2,levels:[{id:'a',type:'skill',state:'passed'},{id:'b',type:'story',state:'passed'},{id:'c',type:'skill',state:'passed'}]}]}]});
  // 链头口径：只取 l0，其余节点不再进候选
  assert.deepEqual(result.candidates.map(l=>l.id),['a']);assert.equal(result.candidates[0].levelIndex,0);
});
const base={startedAt:0,startXp:100,currentXp:100,now:0,minutes:15,xp:40};
test('time limit blocks a new lesson, but lets the current lesson settle',()=>{
  assert.equal(policy.stopDecision({...base,now:900000,inLesson:true}).action,'finish-and-settle-current');
  assert.equal(policy.stopDecision({...base,now:900000}).action,'stop');
});
test('XP is measured as gained XP, with either limit sufficient to stop',()=>{
  assert.equal(policy.stopDecision({...base,currentXp:140}).action,'stop');
  assert.equal(policy.stopDecision({...base,currentXp:139}).mayStartNext,true);
  assert.equal(policy.stopDecision({...base,currentXp:140,settled:false}).action,'finish-and-settle-current');
});
test('missing limits and inconsistent XP stop instead of running indefinitely',()=>{
  assert.throws(()=>policy.stopDecision({...base,minutes:undefined,xp:undefined}));
  assert.throws(()=>policy.stopDecision({...base,currentXp:99}));
});
test('listening and speaking skip policy does not skip story or translation',()=>{
  for(const type of ['listen','listenTap','listenIsolation','listenComprehension','listenComplete','listenSpeak'])assert.equal(policy.skipKind(type),'listening');
  assert.equal(policy.skipKind('speak'),'speaking');
  for(const type of ['translate','match','story'])assert.equal(policy.skipKind(type),null);
});
test('preserves the menu URL for a skill or story without calculating its level', () => {
  for (const path of ['/lesson/unit/24/legendary/3', '/lesson/unit/25/legendary/4', '/lesson/unit/14/legendary/2']) {
    assert.equal(parseLegendaryEntry(path).pathname, path);
  }
  for (const href of [null, '/lesson/unit/24/legendary/0', '/lesson/unit/24/level/3', 'https://example.com/lesson/unit/24/legendary/3']) {
    assert.throws(() => parseLegendaryEntry(href));
  }
});
test('settlement checks the target node ID even when a neighboring level is already legendary', () => {
  const course = { id: 'en', pathSectioned: [{ index: 1, units: [{ unitIndex: 23, levels: [
    { id: 'neighbor', state: 'legendary' },
    { id: 'target', state: 'passed' },
  ] }] }] };
  const slot = { courseId: 'en', sectionIndex: 1, unitIndex: 23, levelIndex: 0, id: 'target' };
  assert.equal(findCourseLevel(course, slot).state, 'passed');
  assert.equal(findCourseLevel(course, { ...slot, courseId: 'es' }), null);
  assert.equal(findCourseLevel(course, { ...slot, id: 'missing' }), null);
});
test('熔断：同一节点失败 2 次就换节点，不掐死整轮', () => {
  const t = policy.createRetryTracker();
  assert.equal(t.fail('a').action, 'retry');
  const second = t.fail('a');
  assert.equal(second.action, 'skip-node');
  assert.equal(second.stop, null, '同节点第 2 次失败不应停止整轮');
  assert.ok(t.skipped.has('a'));
  // 换下一个节点：连续失败计数按“不同节点”累计
  assert.equal(t.fail('b').streak, 2);
});
test('熔断：同一节点重复失败不增加批次连续失败数', () => {
  const t = policy.createRetryTracker({ perNode: 5 });
  t.fail('a'); t.fail('a'); t.fail('a');
  assert.equal(t.fail('a').streak, 1);
  assert.equal(t.fail('b').streak, 2);
});
test('熔断：不同节点连续失败 5 个才 BLOCKED', () => {
  const t = policy.createRetryTracker();
  const ids = ['a', 'b', 'c', 'd', 'e'];
  let last = null;
  for (const id of ids) last = t.fail(id);
  assert.equal(last.stop, 'node-streak');
  assert.equal(last.streak, 5);
});
test('熔断：成功后重置连续失败，另有总尝试次数兜底', () => {
  const t = policy.createRetryTracker({ perNode: 5, nodeStreak: 99, total: 6 });
  t.fail('a'); t.fail('b');
  t.ok('b');
  assert.equal(t.fail('c').streak, 1, '成功后连续失败重新计数');
  const capped = policy.createRetryTracker({ perNode: 99, nodeStreak: 99, total: 3 });
  capped.fail('a'); capped.fail('b');
  assert.equal(capped.fail('c').stop, 'total-attempts');
});
test('链头策略：每个 unit 只取 l0，l1 story 不单独进候选', () => {
  const course = { id: 'fr', pathSectioned: [{ index: 3, type: 'learning', units: [{
    unitIndex: 72,
    levels: [
      { id: 's3u72l0', type: 'skill', state: 'passed', levelIndex: 0 },
      { id: 's3u72l1', type: 'story', state: 'passed', levelIndex: 1 },
      { id: 's3u72l3', type: 'skill', state: 'passed', levelIndex: 3 },
    ] }] }] };
  const r = policy.planCourse(course);
  assert.deepEqual(r.candidates.map((c) => c.id), ['s3u72l0']);
  assert.equal(r.candidates[0].levelIndex, 0);
});
test('链头策略：链头已传奇的单元不再进候选', () => {
  const course = { id: 'fr', pathSectioned: [{ index: 3, type: 'learning', units: [
    { unitIndex: 72, levels: [{ id: 's3u72l0', type: 'skill', state: 'legendary' }, { id: 's3u72l1', type: 'story', state: 'passed' }] },
    { unitIndex: 73, levels: [{ id: 's3u73l0', type: 'skill', state: 'passed' }] },
  ] }] };
  const r = policy.planCourse(course);
  assert.deepEqual(r.candidates.map((c) => c.id), ['s3u73l0']);
});
test('链口径：链头已金 / 整链已金 / 待补清单分开统计', () => {
  const course = { id: 'fr', pathSectioned: [{ index: 3, type: 'learning', units: [
    { unitIndex: 71, levels: [{ id: 'a', type: 'skill', state: 'legendary' }, { id: 'b', type: 'story', state: 'legendary' }, { id: 'c', type: 'duo_radio', state: 'legendary' }] },
    { unitIndex: 72, levels: [{ id: 'd', type: 'skill', state: 'legendary' }, { id: 'e', type: 'story', state: 'passed' }] },
    { unitIndex: 73, levels: [{ id: 'f', type: 'skill', state: 'passed' }] },
  ] }] };
  const r = policy.chainReport(course);
  assert.equal(r.headsGold, 2, '71 和 72 的链头已金');
  assert.equal(r.chainsGold, 1, '只有 71 整链已金');
  assert.deepEqual(r.pending.map((p) => p.id), ['e'], '72 的 l1 story 是继承失败待补');
});
console.log(`结果: ${passed} 通过, 0 失败`);
