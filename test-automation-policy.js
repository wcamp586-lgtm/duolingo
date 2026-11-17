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
  const result=policy.planCourse({id:'en',pathSectioned:[{index:0,type:'learning',units:[{unitIndex:2,levels:[{id:'a',type:'story',state:'legendary'},{id:'b',type:'story',state:'passed'},{id:'c',type:'skill',state:'passed'}]}]}]});
  assert.deepEqual(result.candidates.map(l=>l.id),['b','c']);assert.equal(result.candidates[0].levelIndex,1);
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
console.log(`结果: ${passed} 通过, 0 失败`);
