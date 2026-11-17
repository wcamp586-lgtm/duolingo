// 出一份完整报告：关卡清单、XP、name 题型表现、误配线索。
const fs = require('fs');
const lines = fs.readFileSync(process.argv[2] || 'auto.log', 'utf8').split('\n');

const entries = lines.filter(l => l.startsWith('ENTRY'));
const settled = lines.filter(l => l.startsWith('SETTLED'));
const skips = lines.filter(l => l.startsWith('SKIP_SLOT'));
const nameAns = lines.filter(l => /LESSON_ANSWERED type=name/.test(l));

const xps = settled.map(l => {
  const m = l.match(/xp=(\d+) delta=(-?\d+)/);
  return m ? { xp: +m[1], delta: +m[2] } : null;
}).filter(Boolean);

const levels = entries.map(l => {
  const m = l.match(/ENTRY (s\d+u\d+l\d+) (.+?) → (\S+)/);
  return m ? { key: m[1], name: m[2], url: m[3] } : null;
}).filter(Boolean);

const byType = {};
for (const l of lines) {
  const m = l.match(/LESSON_ANSWERED type=(\w+)/);
  if (m) byType[m[1]] = (byType[m[1]] || 0) + 1;
}

console.log('=== 总览 ===');
console.log('跑过的关卡数:', new Set(levels.map(x => x.key)).size, '（开课', entries.length, '次）');
console.log('结算成功:', settled.length, ' 跳过:', skips.length);
if (xps.length) {
  console.log('XP:', xps[0].xp - xps[0].delta, '→', xps[xps.length - 1].xp,
              '（本次 +' + xps.reduce((a, b) => a + b.delta, 0) + '）');
}
console.log('\n=== 关卡清单 ===');
levels.forEach((x, i) => console.log(String(i + 1).padStart(3) + '. ' + x.key.padEnd(10) + ' ' + x.name));

console.log('\n=== 题型 ===');
Object.entries(byType).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + k + ': ' + v));

console.log('\n=== name 题型 ===');
console.log('答题次数:', nameAns.length);
const nameSkips = skips.filter(s => /name /.test(s));
console.log('name 失败跳过:', nameSkips.length);
nameSkips.forEach(s => console.log('  ' + s.slice(0, 110)));

if (skips.length) {
  console.log('\n=== 所有跳过 ===');
  skips.forEach(s => console.log('  ' + s.slice(0, 110)));
}
