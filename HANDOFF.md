# 交接文档：多邻国答案标注器

代码位置：`/Users/fengzhao/duo-xp/`

## 一、当前目标（已变更，别再按旧目标理解）

**默认（2026-10-31 起）：半自动填充**

- 脚本自动把答案**填上**（并标绿框/序号）
- **开始 / 检查 / 继续 / 结束 全部由用户点**——流程控制权在用户
- 口语题由用户手动跳过

三种模式：`node hint.js`（默认填充）、`--hint`（只标注不点）、`--auto`（连检查/继续也自动，验证/刷课用）。

历史目标（全自动刷 XP）已废弃。

## 二、架构（3 个文件，单一实现）

```
core.js        题池合并 / 选项提取 / 答案计划 / 严格匹配 / 标注分配   ← 纯函数，可离线测
hint.js        浏览器入口：拦截响应、读 DOM、调 core、上标记          ← 不重复实现匹配逻辑
test-core.js   离线测试，引用同一份 core.js                           ← 12 项断言
```

交付脚本和测试**共用 core.js**，这是上一轮最大的工程问题（"改一份、测另一份"），已消除。

## 三、核心机制

### 答案来源
`POST /2023-05-23/sessions` 响应里直接带答案，**不需要 LLM / 视觉 / OCR**。

### 三组题池（必须全部搜索）
| 字段 | 典型条数 | 说明 |
|---|---:|---|
| `challenges` | 17 | 主题池 |
| `mistakesReplacementChallenges` | 17 | 错题替换池，**ID 与主池完全不重叠** |
| `adaptiveInterleavedChallenges.challenges` | 6–9 | 自适应池 |

早期只搜主池，导致大量 `NO_MATCH` 被误判成"服务器没下发答案"。

### 答案字段规律（`buildPlan` 依据）
```
pairs                          → 配对，两个 token 同号
correctTokens                  → 按顺序拼
correctIndices / correctIndex + choices | options → 选项文本
```

### 严格匹配（关键设计决策）
页面选项的**完整多重集**必须与题目选项集合相等才认为匹配：

- 不相等 → 返回 `null`，打印 `NO_MATCH`，**绝不"猜第一道同类型题"**
- 多个候选但答案相同 → 接受
- 多个候选答案不同 → 返回 `null`
- 交互中选项被点掉后变少 → 用 `isSubsetOf` + **当前题身份缓存**沿用，不重新匹配

## 四、诊断问题的修复对照

来自 `~/Documents/ChatGPT/others/duo-xp-review/diagnosis.md`：

| 诊断问题 | 修复 | 验证方式 |
|---|---|---|
| 只认 `challenge-tap-token`，无词块题型进不去 | `readDom` 三级选择器；匹配不再依赖 domType | `dialogue` 端到端标注成功 |
| 用正确答案代替完整选项匹配，失败后猜 | `challengeOptions` 取完整选项；`matchChallenge` 不唯一返回 null | `test-core.js` 12/12 |
| 三题池只搜一组 | `collectChallenges` 合并 | adaptive 池题目标注成功 |
| `lastKey` 提前设，标 0 不重试 | 标 0 不写 lastKey；标记被抹掉自动重标 | 代码审查 |
| 全页 button 子串误标 | `assignMarks` 完整文本优先 + 限定 challenge 容器 + 矩形去重 | 诊断的 `Japan`/`a` 场景单测通过 |
| 验证造假（轮询次数当题数、exact 当判对） | 测试只断言纯函数输出；端到端以 XP 增量为准 | XP 82833 → 82873 |

## 五、已验证 / 未验证

**已验证**
- `node test-core.js` **20/20**
- 端到端传奇课：所有 `MARK n/计划数` 完全相等（`2/2`、`3/3`、`5/5`、`6/6`），**读取与标注索引一致**
- 覆盖题型：`tapComplete` / `translate` / `dialogue` / `readComprehension`
- 覆盖题池：`main` / `replacement` / `adaptive`
- 完成一节传奇课，XP 82833 → 82873（+40）

**未验证**
- 纯手动模式（`node hint.js` 不带 `--auto`）的完整端到端
- `listenIsolation` 的实际标注
- 部分 DOM 重绘后的自动补标（有 sig 检查逻辑，未真实复现）

## 六、2026-10-31 复核问题的修复

复核报告：`~/Documents/ChatGPT/others/duo-xp-review/review-20261031.md`

| 复核问题 | 修复 | 验证 |
|---|---|---|
| P1 读取侧不去重、标注侧去重 → 索引错位 | 三处 `eval` 同一份 `COLLECT_SRC` | 端到端 `n` 恒等于计划数 |
| P1 题目缓存无换题判据（空选项是任何集合子集） | 删除缓存，改 `core.resolveChallenge`：严格匹配 → 唯一超集；空选项 / 不唯一 / 题型不符一律 `null` | 单测 5 项 |
| P2 只要还剩一个标记就不补 | `data-duoSig` + 当前题完整标记数比对，缺一个就重标 | 代码审查 |
| P2 子串错标，测试还断言允许 | `assignMarks` 改严格相等（数字后缀单独显式兼容），测试断言改为 `length === 0` | 单测 |
| （复核未提）题型过滤为空时回退到其他题型 | `matchChallenge` 强制按 domType 过滤，为空即 `null` | 单测「题型不符 -> null」 |
| （复核未提）重复词数字后缀在匹配阶段丢失 | `resolveChallenge` 加去尾数字重试 | 单测「city3 → city」 |
| （复核未提）`speak` 的录音按钮被当选项 | `type === 'speak'` 直接走口语分支 | 代码审查 |

## 七、调试方法

```bash
node hint.js 4 --auto      # 观察 MARK/NO_MATCH 日志
node read-xp.js            # 确认 XP 增量
node test-core.js          # 改 core.js 后必须先跑
```

关键日志：
- `MARK <type>[<pool>] n/计划数` — 第 pool 组池命中，标了 n 个
- `NO_MATCH type=... dom=[...]` + `candidates=[...]` — 页面选项与所有题池都不等，说明是未覆盖题型或 DOM 结构变了
- `SESSION pools={main,replacement,adaptive}` — 三池条数

## 八、踩过的坑（不要重犯）

1. **`overlays.innerHTML = ''` 会破坏 React**，导致后续点击全失效。关弹窗只点 `[data-test="notification-drawer-no-thanks-button"]`，别动 DOM。
2. **不要硬编码屏幕坐标**：路径节点随进度移动。
3. **多邻国渲染两套重叠布局**：选项会重复成 8 个，必须按矩形去重。
4. **句子 tokens 不能当选项**：早期把 `displayTokens` 算进选项集，导致永远匹配不上。
5. **选项带行首序号**（`1Coffee...` / `1\n现在`），匹配前要剥掉。
6. **重复词带数字后缀**（`手机1`），匹配失败时用去尾数字再试一次。
7. **口语题**：`speak` 无选项，`player-skip` 后会出现「麦克风已关闭」提示页，还要再点「继续」。
8. **完成页**（「奖你 X 经验」）需要点「继续」才结算回路径页。

## 九、环境

- Node v24.22.1，playwright 1.64.1（Chromium 156 已缓存）
- `profile/` 是有效登录态，**勿删**；失效跑 `node login.js`
- 账号：有 Super（不掉心），英语课第 9 阶段，日语课保留未动
- 浏览器是独立 Chromium，不影响本机 Chrome

## 十、风险

- 违反多邻国 ToS，有封号风险
- 本方案只显示答案、不代点，检测面小于全自动，但**不是零风险**
