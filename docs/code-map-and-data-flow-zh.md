# 代码地图与数据流

## 这份文档解决什么问题

告诉你当前代码到底是怎么串起来的，后续想改执行链、浏览器接入、状态流转时该从哪里下手。

## 什么时候读

- 想改 `run-next` 的主链。
- 想改 shared CDP / 外部 Chrome 接入。
- 想改 takeover、replay、任务状态或 artifact 落盘。

## 最后验证对象

- `/Volumes/WD1T/outsea/backliner-helper/src/control-plane/run-next.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/execution/scout.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/execution/takeover.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/execution/replay.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/shared/browser-runtime.ts`

## 先看全链路

当前主链不是“神秘 agent 自动操作”，而是一条很直白的控制流：

```text
CLI
 -> resolveBrowserRuntime
 -> runPreflight
 -> load/create promoted profile
 -> load/create task
 -> optional replay
 -> scout
 -> takeover
 -> save task / artifact / playbook
```

这里的第一性原理很简单：

- `control-plane` 负责顺序和状态。
- `execution` 负责浏览器动作。
- `memory` 负责把结果写到磁盘。
- `shared` 负责大家都会用到的底层能力。

## 行为链路拆解

### 1. `resolveBrowserRuntime`

入口：

- `src/shared/browser-runtime.ts`

职责：

- 解析 CLI 的 `--cdp-url`
- 解析环境变量
- 自动发现外部 Chrome
- 从 `/json/version` 拿浏览器元信息

当前优先级：

1. CLI 参数
2. `BACKLINK_BROWSER_CDP_URL`
3. `BROWSER_USE_CDP_URL`
4. `CHROME_CDP_URL`
5. 自动发现 `9222 / 9223 / 9224 / 9229`
6. 最后回退到 `http://127.0.0.1:9333`

想改这里时，改：

- 外部 Chrome 发现策略
- 端口优先级
- external vs headless 的选择规则

不要在这里改：

- 任务状态
- 页面点击逻辑

### 2. `runPreflight`

入口：

- `src/shared/preflight.ts`
- `src/cli/preflight.ts`

职责：

- 验证 `cdp_runtime`
- 验证 Playwright 能否连接
- 检查 `agent-browser`
- 检查 `gog`

这一步的本质目的不是“跑业务”，而是尽早告诉你环境有没有资格开工。

想改这里时，改：

- preflight 检查项
- loopback 冲突提示
- 输出 detail 文案

不要在这里改：

- 提交流程
- 页面分类逻辑

### 3. `replay`

入口：

- `src/control-plane/run-next.ts`
- `src/execution/replay.ts`

职责：

- 如果已有同域 playbook，先尝试重放
- 用模板变量把 `{{promoted_url}}`、`{{submitter_email}}` 代回去
- 如果命中成功信号，直接结束
- 如果失败，再回退到 `scout`

想改这里时，改：

- `ReplayStep` 类型
- replay 成功判定
- anchor 和截图策略

不要在这里改：

- CDP 解析
- takeover 的字段发现

### 4. `scout`

入口：

- `src/execution/scout.ts`

职责：

- 打开目录站入口 URL
- 抽取标题、当前 URL、response status、body excerpt
- 给出 `field_hints`、`auth_hints`、`anti_bot_hints`
- 收集可能的 submit 入口文本

它的本质不是提交，而是“先把地形看清楚”。

想改这里时，改：

- hints 的抽取规则
- submit candidate 的发现规则
- canonical URL 的判断依据

不要在这里改：

- 最终填表
- wait reason code 映射

### 5. `takeover`

入口：

- `src/execution/takeover.ts`

职责：

- 进入 submit surface
- 发现字段
- 按字段语义填入 promoted profile / submitter email
- 点击最终 submit
- 根据页面结果分类为 `WAITING_* / RETRYABLE`
- 必要时生成 playbook

当前 takeover 是“规则式 takeover”，还不是通用 agent worker。

你如果要改页面分类、付费页判断、登录页判断、字段映射，优先改这里。

重点子模块：

- `discoverSubmitTargets()`
  - 找 submit / add listing / get listed 入口
- `discoverFields()`
  - 抽取 input / textarea / select
  - 只保留当前可见字段
- `inferFieldSemantic()`
  - 判断字段是 URL、名称、描述、邮箱、分类、价格还是未知
- `inferCurrentOutcome()`
  - 把页面文本映射成状态和 `wait_reason_code`

### 6. `artifact / task update`

入口：

- `src/memory/data-store.ts`
- `src/memory/trajectory-playbook.ts`
- `src/control-plane/run-next.ts`

职责：

- 写 `task` JSON
- 写 `artifact` JSON
- 写 `playbook`
- 更新 `phase_history`、`latest_artifacts`、`notes`

想改这里时，改：

- 文件路径
- JSON 契约
- playbook 保存时机

不要在这里改：

- 页面点击逻辑

## one-writer 规则

当前 shared CDP 浏览器只允许一个 writer。

锁实现：

- `src/execution/ownership-lock.ts`

当前 owner 只有三个：

- `scout`
- `takeover`
- `replay`

交接边界固定在阶段边界：

- replay 结束
- scout 结束
- takeover 结束

本质目的：

- 避免两个执行器同时控制同一个共享浏览器
- 避免你以为页面状态是 A，其实另一个模块刚刚把它点成了 B

## 你要改哪里

### 想改浏览器接入

从这里开始：

- `src/shared/browser-runtime.ts`
- `src/shared/preflight.ts`
- `src/shared/playwright-session.ts`

### 想改任务状态流转

从这里开始：

- `src/shared/types.ts`
- `src/control-plane/run-next.ts`
- `src/execution/takeover.ts`

### 想改填表 / 登录 / OAuth / takeover

从这里开始：

- `src/execution/takeover.ts`

说明：

- 当前 repo 还没有稳定的通用 OAuth helper。
- 外部 Chrome profile + 共享登录态已经验证有效，但主链里还没抽象成完整自动恢复能力。

### 想改 playbook 和记忆落盘

从这里开始：

- `src/shared/types.ts`
- `src/memory/trajectory-playbook.ts`
- `src/memory/data-store.ts`
- `src/execution/replay.ts`

## 当前实现和北极星架构的差距

这部分很重要，不然你会把架构稿和代码现实混在一起。

当前代码已经做到：

- 外部 Chrome 优先
- shared CDP
- replay / scout / takeover 三段式
- 本地 JSON task / artifact / playbook / profile 落盘
- wait state 细分

当前代码还没有做到：

- `browser-use` 真正接入 CLI 主链
- 通用 OAuth worker
- `gog` 自动恢复 worker
- reporter / watchdog CLI
- 真正的 bounded live takeover budget 控制

所以你后续维护时，要先问一句：

“我是在补当前实现，还是在推进北极星架构？”

如果这个边界不分清，文档和代码都会很快失真。
