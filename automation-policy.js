// Pure planning and budget policy. It never opens or starts a lesson.
// 电台/AI对话和宝箱不是题目，不刷；复习和单元复习也要刷传奇
const TARGET_TYPES = new Set(['skill', 'story', 'practice', 'unit_review']);

function classifyLevel(level) {
  if(level.state==='legendary'||level.pathLevelMetadata?.nodeState==='legendary')return 'already-legendary';
  if(!TARGET_TYPES.has(level.type))return 'derived-or-nontarget';
  if(level.state!=='passed')return 'not-ready';
  return 'check-legendary-entry';
}

// 选关（2026-11-19 修正）：链内 passed 的 skill/story/practice/unit_review 都进候选，
// 运行时要看到 /learn 节点气泡里真实出现的 legendary-node-button 才算有入口，不构造 URL 当证据。
// 实测（s3u72）：l0 传奇后 l1 story 仍 passed，但 story 气泡有「晋升传奇 +40 经验」入口，
// 说明 story 要单独打，不靠链头立即继承；继承机制标「待验证」。
// 已知无独立入口：duo_radio / chest（s3u71 整链金后连带）；unit_review 按实见入口决定（s3u71 实测无入口）。
function planCourse(course) {
  const candidates=[];
  const counts={};
  for(const section of course.pathSectioned||[]) {
    if(section.type!=='learning')continue;
    for(const unit of section.units||[])for(const [levelIndex,level] of (unit.levels||[]).entries()) {
      const reason=classifyLevel(level);
      counts[reason]=(counts[reason]||0)+1;
      if(reason==='check-legendary-entry')candidates.push({
        courseId:course.id,sectionIndex:section.index,unitIndex:unit.unitIndex,
        levelIndex,id:level.id,type:level.type,name:level.debugName,state:level.state,
      });
    }
  }
  return {courseId:course.id,candidates,counts};
}

// 链口径（2026-11-19 口径修正）：
// - headsGold / chainsGold：链头已金 / 整链已金
// - pending：链头已金单元内的非金节点（逐节点，state 如实），不等同「全课程剩余关卡」
// - entryEvidence 三态：observed-present / observed-absent / unknown（默认 unknown，不靠类型猜）
// - 只有 state=passed 且 entryEvidence=observed-present 才算「已确认可刷」
// - unit_review 没有逐关页面证据时保留 unknown
function chainReport(course, entryEvidence) {
  const isGold=(level)=>level&&(level.state==='legendary'||level.pathLevelMetadata?.nodeState==='legendary');
  const rawEvidence=(id)=>{
    if(!entryEvidence)return 'unknown';
    const v=entryEvidence instanceof Map?entryEvidence.get(id):entryEvidence[id];
    return v==='observed-present'||v==='observed-absent'?v:'unknown';
  };
  const pending=[];
  let headsGold=0,chainsGold=0,courseNotGold=0,chainsHeadNotGold=0;
  for(const section of course.pathSectioned||[]) {
    if(section.type!=='learning')continue;
    for(const unit of section.units||[]) {
      const levels=unit.levels||[];
      if(!levels.length)continue;
      const head=levels[0];
      courseNotGold+=levels.filter((l)=>!isGold(l)).length;
      if(!isGold(head)){chainsHeadNotGold++;continue;}
      headsGold++;
      const rest=levels.slice(1);
      if(!rest.some((l)=>!isGold(l))){chainsGold++;continue;}
      for(const [levelIndex,level] of rest.entries()) {
        if(isGold(level))continue;
        pending.push({
          unitIndex:unit.unitIndex,levelIndex:levelIndex+1,id:level.id,type:level.type,state:level.state,
          entryEvidence:level.state==='passed'?rawEvidence(level.id):'unknown',
        });
      }
    }
  }
  const ready=pending.filter((p)=>p.state==='passed'&&p.entryEvidence==='observed-present');
  const absent=pending.filter((p)=>p.entryEvidence==='observed-absent');
  const unknown=pending.filter((p)=>p.entryEvidence==='unknown');
  return {
    headsGold,chainsGold,pending,ready,absent,unknown,
    courseNotGold,chainsHeadNotGold,
    note:'pending 是链头已金单元内的非金节点列表，不等于全课程剩余关卡；全课程剩余用 courseNotGold/headsNotGold',
  };
}

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
