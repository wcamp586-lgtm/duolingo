// 读 auto.log 出摘要：跑了多少关、成功几关、XP 增了多少、卡在哪。
// 用法：node auto-summary.js [日志文件，默认 auto.log]
const fs = require('fs');
const file = process.argv[2] || 'auto.log';
let log;
try { log = fs.readFileSync(file, 'utf8'); } catch (e) { console.error('读不到 ' + file); process.exit(1); }

const lines = log.split('\n');
const entries = lines.filter((l) => l.startsWith('ENTRY'));
const settled = lines.filter((l) => l.startsWith('SETTLED'));
const blocked = lines.filter((l) => l.startsWith('BLOCKED'));
const end = lines.filter((l) => l.startsWith('END ')).pop();

const xps = settled.map((l) => {
  const m = l.match(/xp=(\d+)\s+delta=(-?\d+)/);
  return m ? { xp: Number(m[1]), delta: Number(m[2]) } : null;
}).filter(Boolean);

const ok = xps.filter((x) => x.delta > 0).length;
const zero = xps.filter((x) => x.delta <= 0).length;

console.log('=== ' + file + ' ===');
console.log(`开课 ENTRY     : ${entries.length}`);
console.log(`结算 SETTLED   : ${settled.length}（+XP ${ok} 关 / +0 ${zero} 关）`);
console.log(`卡住 BLOCKED   : ${blocked.length}`);
if (xps.length) {
  console.log(`XP             : ${xps[xps.length - 1].xp}（累计 +${xps.reduce((a, b) => a + b.delta, 0)}）`);
}
if (end) console.log('结束行         : ' + end);

if (blocked.length) {
  console.log('\n--- 卡住原因（去重） ---');
  const seen = new Set();
  for (const b of blocked) {
    const k = b.replace(/\d+/g, 'N').slice(0, 110);
    if (seen.has(k)) continue;
    seen.add(k);
    console.log('  ' + b.slice(0, 140));
  }
}

const lastEntries = entries.slice(-5);
if (lastEntries.length) {
  console.log('\n--- 最近开课 ---');
  for (const e of lastEntries) console.log('  ' + e.slice(0, 130));
}
