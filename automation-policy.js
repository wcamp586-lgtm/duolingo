// Pure planning and budget policy. It never opens or starts a lesson.
// 电台/AI对话和宝箱不是题目，不刷；复习和单元复习也要刷传奇
const TARGET_TYPES = new Set(['skill', 'story', 'practice', 'unit_review']);

function classifyLevel(level) {
  if(level.state==='legendary'||level.pathLevelMetadata?.nodeState==='legendary')return 'already-legendary';
  if(!TARGET_TYPES.has(level.type))return 'derived-or-nontarget';
  if(level.state!=='passed')return 'not-ready';
  return 'check-legendary-entry';
}

// 链头策略（2026-11-19 新口径）：每个 unit 是一条链，链头是 l0，传奇只挑链头。
// 第 1 步实验（s3u72l0 传奇）：l0 变 legendary，l1 story 仍 passed —— story 不靠链头立即继承；
// practice / unit_review 该实验未覆盖（l3 未 passed、l12 locked），标 TODO，不猜。
// 已知：duo_radio / chest 无独立入口，整链金后连带（s3u71 实证）。
// TARGET_TYPES 仍保留给 planNormal 与历史口径；链头本身类型不限，但只有可传奇类型才会进候选。
function planCourse(course) {
  const candidates=[];
  const counts={};
  for(const section of course.pathSectioned||[]) {
    if(section.type!=='learning')continue;
    for(const unit of section.units||[]) {
      const levels=unit.levels||[];
      if(!levels.length)continue;
      // 每个 unit 只取 l0：后续节点靠整链连带，没跟上的进「继承失败待补」清单
      const level=levels[0];
      const reason=classifyLevel(level);
      counts[reason]=(counts[reason]||0)+1;
      if(reason==='check-legendary-entry')candidates.push({
        courseId:course.id,sectionIndex:section.index,unitIndex:unit.unitIndex,
        levelIndex:0,id:level.id,type:level.type,name:level.debugName,state:level.state,
      });
    }
  }
  return {courseId:course.id,candidates,counts};
}

// 链口径：链头已金 N 条 / 整链已金 N 条 / 继承失败待补清单（链头已金但单元内还有非 legendary 节点）。
function chainReport(course) {
  const isGold=(level)=>level&&(level.state==='legendary'||level.pathLevelMetadata?.nodeState==='legendary');
  const pending=[];
  let headsGold=0,chainsGold=0;
  for(const section of course.pathSectioned||[]) {
    if(section.type!=='learning')continue;
    for(const unit of section.units||[]) {
      const levels=unit.levels||[];
      if(!levels.length)continue;
      const head=levels[0];
      if(!isGold(head))continue;
      headsGold++;
      const rest=levels.slice(1);
      const notGold=rest.filter((l)=>!isGold(l));
      if(!notGold.length){chainsGold++;continue;}
      for(const [levelIndex,level] of rest.entries()) {
        if(isGold(level))continue;
        pending.push({unitIndex:unit.unitIndex,levelIndex:levelIndex+1,id:level.id,type:level.type,state:level.state});
      }
    }
  }
  return {headsGold,chainsGold,pending};
}

// 普通课：前沿节点可能是 chest（宝箱，点「打开」）或 duo_radio（对话课，可能要「稍后选择」），
// 都要返回，由 auto-runner 按类型决定入口；否则解锁链会卡在它们身上。
function planNormal(course) {
  const out=[];
  for(const section of course.pathSectioned||[]) {
    if(section.type!=='learning')continue;
    for(const unit of section.units||[])for(const [levelIndex,level] of (unit.levels||[]).entries()) {
      if(level.state!=='active')continue;
      out.push({
        courseId:course.id,sectionIndex:section.index,unitIndex:unit.unitIndex,
        levelIndex,id:level.id,type:level.type,name:level.debugName,state:level.state,
      });
    }
  }
  return out;
}

function stopDecision({startedAt,startXp,currentXp,now=Date.now(),minutes,xp,inLesson=false,settled=true}) {
  if(!Number.isFinite(startedAt)||!Number.isFinite(startXp)||!Number.isFinite(currentXp))throw new Error('Missing measured time/XP');
  if(!(minutes>0||xp>0))throw new Error('Set a positive time or XP limit');
  if((minutes!=null&&(!Number.isFinite(minutes)||minutes<=0))||(xp!=null&&(!Number.isFinite(xp)||xp<=0)))throw new Error('Invalid limit');
  if(currentXp<startXp)throw new Error('XP decreased; check account/course');
  const xpGain=currentXp-startXp;
  const elapsedMs=Math.max(0,now-startedAt);
  const reasons=[];
  if(minutes>0&&elapsedMs>=minutes*60000)reasons.push('time');
  if(xp>0&&xpGain>=xp)reasons.push('xp');
  const reached=reasons.length>0;
  const action=reached?(inLesson||!settled?'finish-and-settle-current':'stop'):'continue';
  return {action,reasons,xpGain,elapsedMs,mayStartNext:!reached&&!inLesson&&settled};
}

function skipKind(type) {
  if(type==='speak'||type==='listenSpeak')return type==='speak'?'speaking':'listening';
  return /^listen/.test(type||'')?'listening':null;
}

// 失败熔断：节点维度（同一节点 2 次失败就换下一个可达节点）与批次维度
// （不同节点连续 5 个失败才 BLOCKED）分开计数，另用总尝试次数兜底。
// 纯函数，便于离线测试；auto-runner 只负责把结果写进日志。
function createRetryTracker({ perNode = 2, nodeStreak = 5, total = 40 } = {}) {
  const attempts = new Map();
  const skipped = new Set();
  let lastFailed = null;
  let streak = 0;
  let totalAttempts = 0;
  return {
    fail(id) {
      totalAttempts++;
      const n = (attempts.get(id) || 0) + 1;
      attempts.set(id, n);
      // 只有换了节点才加批次维度计数：同一节点重复失败不能掐死整轮
      if (id !== lastFailed) { streak++; lastFailed = id; }
      let action = 'retry';
      if (n >= perNode) { skipped.add(id); action = 'skip-node'; }
      let stop = null;
      if (streak >= nodeStreak) stop = 'node-streak';
      else if (totalAttempts >= total) stop = 'total-attempts';
      return { attempts: n, action, stop, streak, totalAttempts };
    },
    ok(id) { attempts.delete(id); lastFailed = null; streak = 0; },
    attempts,
    skipped,
  };
}

module.exports={classifyLevel,planCourse,planNormal,stopDecision,skipKind,createRetryTracker,chainReport};
