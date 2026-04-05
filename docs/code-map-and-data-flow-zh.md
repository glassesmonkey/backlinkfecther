# 代码地图与数据流

## 这份文档解决什么问题

告诉你当前代码是怎么串起来的。后续如果想改 bounded worker 主链、队列、浏览器接入、账号复用，从哪里下手看这里。

## 什么时候读

- 想改主链执行顺序。
- 想改 queue / lease / bounded worker 语义。
- 想改注册型站点账号复用、`gog`、playbook 蒸馏。

## 最后验证对象

- `/Volumes/WD1T/outsea/backliner-helper/src/control-plane/task-queue.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/control-plane/task-prepare.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/control-plane/task-finalize.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/execution/takeover.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/shared/browser-runtime.ts`

## 先看全链路

当前真正的生产主链是：

```text
OpenClaw cron
 -> operator skill
 -> enqueue / claim
 -> task-prepare
 -> replay (if playbook exists)
 -> scout
 -> Codex-driven browser-use CLI
 -> task-record-agent-trace
 -> task-finalize
 -> save task / playbook / account / vault
```

这里的第一性原理是：

- `control-plane` 负责顺序和状态
- `execution` 负责浏览器动作
- `memory` 负责把一切落盘
- `shared` 负责 CDP、邮箱、CLI wrapper 这些底座
- `operator skill` 负责让 Codex 充当运行时大脑

## 行为链路拆解

### 1. queue 和 lease

入口：

- `src/control-plane/task-queue.ts`

职责：

- `enqueueSiteTask()`
  - 把一个网站写成 `READY`
- `claimNextTask()`
  - 先 reaper 过期 lease
  - 再按顺序挑选：
    - 最老的 `READY`
    - 再是最老的、退避时间已过的 `RETRYABLE`
  - 写 `task-worker-lease.json`

如果你想改：

- 单任务 lease TTL
- 自动重试次数
- READY / RETRYABLE 的挑选顺序

优先改这里，不要直接去改 skill。

### 2. `task-prepare`

入口：

- `src/control-plane/task-prepare.ts`

职责：

- 跑 preflight
- 尝试同域 replay
- replay 不成就 scout
- 产出 `PrepareResult`
- 给 operator skill 明确这些信息：
  - 当前是否要进 agent loop
  - 当前 canonical URL 是什么
  - 是否已有可复用 account
  - 是否像注册型站点
  - 推荐的 email alias / mailbox query

当前约束：

- 新站不再走 Playwright probe
- 若注册路线很可能会用到邮箱，但 `gog` 不可用，就直接停在 `RETRYABLE`

### 3. Codex-driven browser loop

入口：

- `src/execution/browser-use-cli.ts`
- `src/execution/takeover.ts`
- `web-backlinker-v2-operator` skill

职责分工：

- repo 负责 browser-use CLI wrapper 和 Playwright finalization
- operator skill 负责让 Codex 读取页面状态、决定下一步动作、执行 bounded loop

这一步很重要：

- 当前 repo **不是** 自己在长期持有 agent 大脑
- 当前 repo 只提供底座
- 真正的运行时决策来自 operator skill 里的 Codex 会话

### 4. `task-record-agent-trace`

入口：

- `src/control-plane/task-record-agent-trace.ts`

职责：

- 把 operator skill 跑出来的 trace 落盘成 `{taskId}-agent-loop.json`
- 把 finalization 所需的 handoff 和 account draft 写到 `runtime/{taskId}-pending-finalize.json`

本质上它是：

- skill 和 repo 的桥接点

### 5. `task-finalize`

入口：

- `src/control-plane/task-finalize.ts`
- `src/execution/takeover.ts`

职责：

- 用 Playwright 连回 shared CDP
- 基于当前页面做最终截图和状态分类
- 成功时蒸馏 playbook
- 如果本轮创建或更新了账号：
  - 更新 account registry
  - 更新 credential vault
- 最后释放 worker lease 和浏览器锁

### 6. account registry 和 credential vault

入口：

- `src/memory/account-registry.ts`
- `src/memory/credential-vault.ts`
- `src/shared/email.ts`

职责：

- account registry
  - 保存“这个站已有可复用账号”这个事实
- credential vault
  - 保存真正敏感的邮箱/密码
- email helper
  - 生成 plus alias
  - 生成 credential ref

记住这个边界：

- registry 是业务记忆
- vault 是 secret 存储

不要把两者重新混起来。

## one-writer 规则

当前 shared CDP 浏览器始终只允许一个 writer。

锁实现：

- `src/execution/ownership-lock.ts`

当前 owner：

- `replay`
- `scout`
- `takeover:agent-loop`
- `finalization:playwright`

worker lease 和 browser ownership lock 是两层不同东西：

- worker lease：一个网站任务是否还在跑
- browser ownership lock：当前哪个 phase 在写浏览器

## 你要改哪里

### 想改队列和定时 worker

从这里开始：

- `src/control-plane/task-queue.ts`
- `src/cli/index.ts`

### 想改注册型站点和账号复用

从这里开始：

- `src/control-plane/task-prepare.ts`
- `src/control-plane/task-finalize.ts`
- `src/memory/account-registry.ts`
- `src/memory/credential-vault.ts`
- `src/shared/email.ts`

### 想改浏览器接入

从这里开始：

- `src/shared/browser-runtime.ts`
- `src/shared/preflight.ts`
- `src/shared/playwright-session.ts`

### 想改最终页面分类

从这里开始：

- `src/execution/takeover.ts`

### 想改 skill 主入口协议

从这里开始：

- `/Volumes/WD1T/outsea/backliner-helper/codex-skills/web-backlinker-v2-operator/SKILL.md`

不要直接把 `/Users/gc/.codex/skills/web-backlinker-v2-operator/` 当源码改。  
运行时目录只是安装副本，改完 repo source 后要跑 `pnpm sync-skills`。

## 当前实现和北极星架构的差距

当前代码已经做到：

- 单站点 bounded worker
- queue + lease + reaper
- shared CDP
- replay / scout / finalization
- account registry + credential vault

当前代码还没有做到：

- 独立 watchdog 进程
- 自动创建 OpenClaw cron
- 通用 OAuth worker
- 完整的 `gog` 自动恢复 runner

所以现在最该坚持的原则是：

- 先把单站 worker 跑稳
- 不要把系统又提前做成多层 runner/worker/watchdog 平台
