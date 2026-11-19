# 关卡类型覆盖表（法语，2026-11-18）

数据来源：本轮只读抓取的 `french-course-structure.json`（`currentCourse.pathSectioned`）、`french-course-inventory.json`（逐关 7498 行）、`french-page-evidence.json`（s3u69–72 页面抽样）、本地日志、代码和离线测试。未导出登录资料，未做题、未点检查/继续/结束。

## 全量规模

- 9 sections / 995 units / 7498 nodes。
- 类型：skill 1988、story 1033、practice 1123、unit_review 995、chest 1036、duo_radio 1323。
- 状态：legendary 212、passed 558、active 1、locked 5805、unit_test 922。
- 普通模式：当前只选 active（1 个）；6575 个节点类型有代码入口但非 active；922 个 `unit_test` 状态的 skill 节点不在 `planNormal`（只选 active）也不在 `planCourse`（只选 passed）。

## 类型表

| 类型 | 识别 / 普通推进 | 普通结算 | 传说入口（页面证据） | 状态 / 缺口 |
|---|---|---|---|---|
| `skill` | `planNormal` 选 active；`/lesson`；`LESSON` / `LEVEL_REVIEW` 按 `skillId+levelIndex` | XP 到账（state 可仍 active） | 页面实见：4/4 passed 样本有 `legendary-node-button` | 普通完成；传说页面可见 |
| `story` | `planNormal` 选 active story；stories API + `story-runner` | 到 `STORY_DONE` 后点明确结束控件并结算；控件不明确时保留窗口等人工 | 页面实见：5/5 passed 样本有入口 | 普通结算：控件明确时自动；传说页面可见 |
| `practice` | `practice`；`/lesson`；`LEXEME_PRACTICE` / `UNIT_PRACTICE` | XP 到账 | 页面实见：4/4 passed 样本有入口 | 普通完成；传说页面可见 |
| `unit_review` | `unit_review`；`UNIT_REVIEW` | 本地未见 `SETTLED` | 页面实见：2/2 passed 样本**无**入口 | 代码 `TARGET_TYPES` 包含它，但页面样本显示平台不提供；普通结算无证据 |
| `chest` | `chest`；`/learn` 点「打开」 | 无 XP，按 state 变化 | 页面未渲染，无法判定 | 无页面/日志证据 |
| `duo_radio` | `duo_radio`；`prepareDeferredRadio` | 跳过内容后按 state + XP 结算 | 页面实见：9/9 passed 样本**无**入口 | 跳过三态已实现；无入口/点击失败/没变化待处理；传说样本无入口 |

## 三类结论

- a) 平台页面实见没有传说入口（样本范围 s3u69–71）：`duo_radio` 9/9 passed、`unit_review` 2/2 passed。只覆盖这一段，不外推到整门。
- b) 平台有但代码没支持：本地暂无确证。`unit_review` 方向相反——代码包含、页面样本没入口。
- c) 尚无证据：`chest`（未渲染）、922 个 `unit_test` skill、所有 locked、其他 section/unit；212 个 `legendary` 只表示已完成，不证明入口。

## radio 判定规则（2026-11-18 验收补正）

- 点「稍后选择」本身不是成功证据；弹窗收起、URL/文本变化也不算。
- 唯一成功：同一 unit 的正确后续节点打开、点「开始」成功、且 `lesson-guard` 判定为 `question`（题目/挑战容器真的出现）→ 只打一条 `RADIO_ADVANCED id=… next=… evidence=question url=…`。
- 待处理（抛错，外层标记 skipped、不重试、不记 `SKIP_SLOT`）：无入口 `RADIO_UNSUPPORTED`；点「稍后选择」失败 `RADIO_SKIP_CLICK_FAILED`；点了完全没变化 `RADIO_SKIP_NO_CHANGE`；弹窗收起/停在 `/lesson` 但没出现题目容器 `RADIO_NO_PROGRESS`；后续节点或「开始」点击失败 `RADIO_NEXT_CLICK_FAILED`；多个「开始」同时可见且无法唯一对应 `RADIO_NEXT_AMBIGUOUS`（不点击）；离开 `/lesson` 的误导航 `RADIO_WRONG_PAGE`。
- 判定顺序：入口 → 点击 → 弹窗/页面变化 → 同 unit 后续节点（复用路径 DOM 状态，不发新请求）→ 数「开始」候选（必须唯一，否则 `RADIO_NEXT_AMBIGUOUS`）→ 点「开始」→ 路由仍在 `/lesson` → 题目容器出现 → 才记成功。

## 下一批要做的关卡

1. `chest`：需要页面样本/入口，确认「打开」、无 XP、state→passed。
2. `unit_test` 状态的 922 个 skill：确认产品语义，以及是否应进入普通/传说目标。
3. `unit_review`：页面样本显示无传奇入口，和代码 `TARGET_TYPES` 冲突；先复核再决定是否从目标里移除。
4. `duo_radio`：补“点击成功且页面变化 / 点击失败 / 没变化 / 无入口”四态的真实页面证据。
5. 其他 section/unit：补页面抽样，当前页面证据只覆盖 s3u69–72。
