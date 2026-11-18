// Pure planning and budget policy. It never opens or starts a lesson.
// 电台/AI对话和宝箱不是题目，不刷；复习和单元复习也要刷传奇
const TARGET_TYPES = new Set(['skill', 'story', 'practice', 'unit_review']);

function classifyLevel(level) {
  if(level.state==='legendary'||level.pathLevelMetadata?.nodeState==='legendary')return 'already-legendary';
  if(!TARGET_TYPES.has(level.type))return 'derived-or-nontarget';
  if(level.state!=='passed')return 'not-ready';
  return 'check-legendary-entry';
}

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

module.exports={classifyLevel,planCourse,planNormal,stopDecision,skipKind};
