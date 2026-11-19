# 多邻国答案标注器

**目录**：`/Users/fengzhao/Projects/duolingo`
**当前运行手册**：[RUNBOOK.md](RUNBOOK.md)。本文只做入口说明；HANDOFF.md、AUTOMATION-PLAN.md、STORY-COURSE-HANDOFF.md、HANDOVER.md 是历史记录，不再维护。

## 两种模式

- **半自动（默认）**：`node hint.js`。脚本拦截 session、把答案填上并标绿框；「开始 / 检查 / 继续 / 结束」都由你点，口语题自己跳过。
- **全自动**：`node auto-runner.js`。选关、进课、作答、检查/继续、结算由脚本完成；默认刷传奇课，`--normal` 刷当前普通课。故事课全部答完后，有明确的结束/继续控件就自动点掉并结算；控件不明确或点不动时保留专用窗口和当前页面，等人工处理。开跑前必须先读 [RUNBOOK.md](RUNBOOK.md)。

## 用法

```bash
cd /Users/fengzhao/Projects/duolingo

node hint.js                 # 半自动：自动填答案，流程你控制
node hint.js --hint          # 只标绿框，不点
node hint.js --nopunct       # 填答案时去掉末尾标点
node hint.js 4 --auto        # 单课全自动（旧入口，验证用）
node auto-runner.js --minutes 60              # 全自动传奇课，时间上限 60 分钟
node auto-runner.js --normal --minutes 60     # 全自动普通课
node auto-runner.js --dry-run --minutes 60    # 只看队列（11-04 的 course-path.json 快照）
node read-xp.js              # 读账号总 XP
npm test                     # 离线测试：不联网、不使用 profile/
```

`auto-runner.js` 必须给 `--minutes` 或 `--xp`；它不选课程，刷的是账号当前活动课程，开跑前按 RUNBOOK 第一节核对。

## 原理

- 拦截 `POST /2023-05-23/sessions`，答案随题目下发，零 AI / 零 API 成本。
- 三组题池合并：`challenges` / `mistakesReplacementChallenges` / `adaptiveInterleavedChallenges.challenges`，并兼容 `adaptiveChallenges`。
- 严格匹配完整选项多重集；不唯一就 `NO_MATCH`，不猜。部分点选后按「唯一超集」沿用。
- 标注按矩形去重，覆盖多邻国两套重叠布局。

## 文件

| 文件 | 作用 |
|---|---|
| `core.js` | 题池合并、选项提取、答案计划、严格匹配、标注分配 |
| `hint.js` | 半自动浏览器入口：拦截响应、读 DOM、填答案、标绿框 |
| `lesson-dom.js` | 共用页面读取 / 点击 / 填框实现（hint 与 lesson-runner 共用） |
| `lesson-runner.js` | 普通课全自动执行器：一步 = 读 DOM → 认题 → 作答 → 推进 |
| `story-runner.js` | 故事课自动作答 |
| `auto-runner.js` | 全自动调度器：选关、进课、结算、时间/XP 停止 |
| `automation-policy.js` | 纯函数：选关、停止判定、听说题跳过策略 |
| `legendary-entry.js` | 传奇课入口（直接构造 URL） |
| `test-*.js` | 离线测试；`npm test` 全跑 |
| `archive/` | 旧脚本存档（batch-test、probe-*、旧 prepareLegendary） |
| `LEVEL-COVERAGE.md` | 关卡类型覆盖表、证据与待支持缺口 |
| `french-course-structure.json` / `french-course-inventory.json` / `french-page-evidence.json` | 法语整门结构、逐关清单、页面传说入口抽样（2026-11-18） |
| `read-xp.js` / `login.js` | 读总 XP / 登录态失效时重新登录 |
| `profile/` | 登录态，**勿删** |

## 验证与限制

- `npm test` 当前 140 项全过（core 50 / stories 7 / policy 14 / lesson-runner 6 / lesson-guard 10 / story-done 5 / progress-touch 4 / story-done-main 1 / story-flow 4 / node-entry 8 / story-sig 2 / story-finish 4 / radio-skip 12 / radio-tap 3 / radio-quiz 10），不联网、不使用 `profile/`。
- 全自动实测：传奇 3h 75 关/+3200 XP；法语普通课单轮 14 关/+250 XP。
- radio：点「稍后选择」本身不算成功。要同一 unit 的后续节点打开、点「开始」成功、且题目/挑战容器真的出现，才记唯一一条 `RADIO_ADVANCED`；点击失败、点击后没变化、弹窗收起但没推进、后续入口点击失败、多个「开始」无法唯一对应、误导航、没有入口分别记 `RADIO_SKIP_CLICK_FAILED` / `RADIO_SKIP_NO_CHANGE` / `RADIO_NO_PROGRESS` / `RADIO_NEXT_CLICK_FAILED` / `RADIO_NEXT_AMBIGUOUS` / `RADIO_WRONG_PAGE` / `RADIO_UNSUPPORTED`，都算待处理，不猜下一节点。法语曾停在非题目页，已有超时兜底。普通课「新单词」、英语偶发 nomatch、日语注音 nomatch 仍不稳。
- 半自动模式的完整端到端仍以人工使用为主，未做自动化验收。
- 进课入口仍需按 RUNBOOK 检查当前课程；`auto-runner` 不替你切课程。

## 风险

- 违反多邻国服务条款，封号、清进度是真实可能。
- 半自动只显示/填答案，但 `hint.js --auto` 和 `auto-runner.js` 会代点，检测面比半自动大。
- 不要声称「真人速度就安全」或「某 XP 阈值不会触发」；连续多天跑尤其要注意。
- 只做页面操作，不做指纹伪装、代理轮换或验证码绕过。
