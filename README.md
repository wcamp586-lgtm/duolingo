# 多邻国答案标注器

### 故事课（2026-11-03 实测）

进入故事课后自动作答、自动推进对话；最后一道题完成后停在绿色「继续」，结束课程由用户点击。
故事逻辑在 `story-runner.js`，普通课程仍使用原有填充逻辑。

已在 The Basketball Player 当前会话验证选择、指词、排序、短语选择及 5 组配对。
选择题点答案所在行内的 `[data-test="stories-choice"]`，不点击答案文字。
每题等故事继续按钮启用后记录 `STORY_VERIFIED`，每组配对检查词块禁用后记录 `STORY_PAIR_VERIFIED`。
异常时保存完整页面和状态到 `story-debug/failure-*`，停止对该会话继续猜选。

`npm test` 运行核心测试及离线浏览器故事测试；不会使用 `profile/` 或访问网站。

**做什么**：脚本自动把答案填上（并标绿框），但**开始 / 检查 / 继续 / 结束都由你点**。

## 用法

```bash
cd ~/duo-xp
node hint.js
```

1. 浏览器打开学习页，**你点「开始」进课**
2. 题目出现后，脚本自动填好答案：
   - 选择题/词块题 → 自动点选（绿框 + 序号）
   - **打字题 → 自动输入整句**（`FILL translate -> "..."`）
   - **缺词填空 → 自动输入缺的词**（`FILL completeReverseTranslation`）
   - **阅读题 / 定义题 → 自动勾选**（`MARK readComprehension` / `definition`）
   - 重复词展开（`开始`/`开始3`）会自动去重匹配
3. **你点「检查」→「继续」**，下一题脚本再自动填
4. 遇到口语题自己点「现在不做口语题」
5. 做完你点「结束」

### 三种模式

```bash
node hint.js            # 默认：自动填答案，流程你控制
node hint.js --hint     # 只标绿框，不替你点
node hint.js --nopunct  # 填答案时去掉末尾标点
node hint.js 4 --auto   # 全自动（填答案 + 检查/继续），验证/刷课用
node hint.js 4          # 直接进 unit 4 传奇课
node test-core.js       # 离线测试（不联网、不开浏览器）
node read-xp.js         # 读当前总 XP
```

## 原理

- 拦截 `POST /2023-05-23/sessions`：多邻国把每道题的答案直接下发，**零 AI 调用、零 API 成本**
- 三组题池全部合并搜索：`challenges` / `mistakesReplacementChallenges` / `adaptiveInterleavedChallenges`
- **严格匹配**：页面完整选项与题目选项逐项相等才标；匹配不唯一时**不标**并打印 `NO_MATCH`（不猜答案）
- 标注：完整文本优先、限定在当前题容器内、按矩形去重（多邻国渲染两套重叠布局）

## 已验证

- 离线 `test-core.js` **20/20 通过**
- 端到端：`tapComplete` / `translate` / `dialogue` / `readComprehension`，覆盖 main / replacement / adaptive 三池；所有题目标记数 `n` 与计划数完全相等（索引一致）
- **打字题实测成功**：`FILL translate[main] -> "This park is very famous." ok` 连续多题正确填入
- 完整做完一节传奇课，**XP 82833 → 82873（+40）**

## 未验证（诚实标注）

- 重复词展开（`开始3`）与「只填一半词」的输入框题的端到端
- 纯手动模式（`node hint.js` 不带 `--auto`）的完整端到端
- `listenIsolation` 的实际标注效果
- 部分 DOM 重绘后的自动补标（有 `data-duoSig` 检查逻辑，未真实复现）

## 已知限制

- **进课入口仍需手动点**：路径节点位置随学习进度变化，自动定位不稳定
- 口语题（`speak`）没有可选项，无法提示，只能跳过
- 多邻国前端改版若改了 `data-test` / DOM 结构，需要更新 `hint.js` 里的选择器

## 风险

- 违反多邻国服务条款，存在封号风险
- 本方案只做「显示答案」，点击行为全是你自己的，检测面比全自动小，但不是零风险
- 建议保持真人节奏，一天 1–2 节

## 文件

| 文件 | 作用 |
|---|---|
| `core.js` | 核心：题池合并、选项提取、答案计划、严格匹配、标注分配 |
| `hint.js` | 浏览器入口：拦截响应、读 DOM、调 core、上标记 |
| `test-core.js` | 离线测试（引用同一份 `core.js`） |
| `read-xp.js` | 读账号总 XP |
| `login.js` | 登录态失效时重新登录 |
| `profile/` | 登录态，**勿删** |

> 交付脚本和测试**调用同一份 `core.js`**，不存在「改一份、测另一份」。
