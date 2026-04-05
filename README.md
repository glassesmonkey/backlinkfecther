# Backliner Helper

## 这份文档解决什么问题

告诉你这套系统现在是什么、主入口到底在哪、第一次该跑哪几个命令。

## 什么时候读

- 第一次接手这个 repo。
- 想确认 `skill` 和 `repo` 各负责什么。
- 想在 OpenClaw 或本机把单站点 bounded worker 跑起来。

## 最后验证对象

- `/Volumes/WD1T/outsea/backliner-helper/src/cli/index.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/control-plane/task-queue.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/control-plane/task-prepare.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/control-plane/task-finalize.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/shared/preflight.ts`
- `/Users/gc/.codex/skills/web-backlinker-v2-operator/SKILL.md`

## 这是什么

Backliner Helper 现在是一个 **单站点、严格串行、定时触发** 的执行底座。

- `repo 代码`
  - 负责任务队列、lease、shared CDP 浏览器连接、replay、scout、finalization、account registry、credential vault、artifact/playbook 落盘。
- `skill`
  - `web-backlinker-v2-architect` 负责架构守门。
  - `web-backlinker-v2-operator` 负责实际运行协议，由 Codex/OpenClaw 会话驱动 `browser-use CLI`。

当前这份 README 和 `docs/` 下文档是**实现层唯一真相源**。  
skill 不再复制完整运行细节，只负责入口和约束。

## 调用链

```text
OpenClaw cron
 -> operator skill
 -> repo CLI primitives
 -> shared CDP browser / gog
 -> directory site

Codex
 -> operator skill / architect skill
 -> repo docs
 -> repo code
```

## 当前主入口

生产路径不是 `run-next`。

当前推荐主入口是：

```text
OpenClaw cron
 -> $web-backlinker-v2-operator
 -> claim-next-task
 -> task-prepare
 -> Codex-driven browser-use CLI
 -> task-record-agent-trace
 -> task-finalize
 -> exit
```

`run-next` 现在只保留为本地调试入口。

## 最短可运行路径

### 1. 启动一个外部 Chrome

```bash
open -na "/Applications/Google Chrome.app" --args \
  --remote-debugging-port=9223 \
  '--remote-allow-origins=*' \
  --user-data-dir=/tmp/chrome-cdp \
  about:blank
```

确认 CDP 正常：

```bash
curl http://127.0.0.1:9223/json/version
```

### 2. 准备运行环境

```bash
cd /Volumes/WD1T/outsea/backliner-helper
export BACKLINK_BROWSER_CDP_URL=http://127.0.0.1:9223
export BACKLINER_VAULT_KEY='replace-with-a-stable-secret'
pnpm preflight
```

说明：

- `BACKLINER_VAULT_KEY` 用来解密本地凭据库。
- 当前生产主路径**不要求** `OPENAI_API_KEY`。
- `gog` 建议提前完成登录授权，因为注册型站点会依赖邮箱验证码 / magic link。

### 3. 手工演练一次单站 worker

先入队：

```bash
pnpm enqueue-site -- \
  --task-id demo-futuretools \
  --directory-url https://futuretools.io/ \
  --promoted-url https://exactstatement.com/ \
  --submitter-email-base support@exactstatement.com \
  --confirm-submit
```

再 claim 一个任务：

```bash
pnpm claim-next-task -- --owner local-debug
```

然后 prepare：

```bash
pnpm task-prepare -- --task-id demo-futuretools
```

接下来由 operator skill 或你手工驱动 `browser-use CLI`。  
跑完后，把 trace 写回：

```bash
pnpm task-record-agent-trace -- \
  --task-id demo-futuretools \
  --payload-file /tmp/demo-futuretools-trace.json
```

最后做 Playwright 收口：

```bash
pnpm task-finalize -- --task-id demo-futuretools
```

## 当前代码地图

- `src/cli/`
  - 对外命令入口：`enqueue-site`、`claim-next-task`、`task-prepare`、`task-record-agent-trace`、`task-finalize`、`run-next`
- `src/control-plane/`
  - 单站 bounded worker 的顺序和状态转换
- `src/execution/`
  - replay、scout、browser ownership lock、agent takeover finalization
- `src/memory/`
  - task / artifact / playbook / account registry / credential vault 落盘
- `src/shared/`
  - shared CDP runtime、preflight、Playwright session、邮箱与 `gog` helper

## 先看哪份文档

| 你现在的问题 | 先看哪份 |
| --- | --- |
| 想先跑起来 | [docs/ops-runbook-zh.md](/Volumes/WD1T/outsea/backliner-helper/docs/ops-runbook-zh.md) |
| 想改 bounded worker 主链 | [docs/code-map-and-data-flow-zh.md](/Volumes/WD1T/outsea/backliner-helper/docs/code-map-and-data-flow-zh.md) |
| 想知道状态、lease、account、artifact 长什么样 | [docs/contracts-and-states-zh.md](/Volumes/WD1T/outsea/backliner-helper/docs/contracts-and-states-zh.md) |
| 想知道某个目录站之前发生过什么 | [docs/site-casebook-zh.md](/Volumes/WD1T/outsea/backliner-helper/docs/site-casebook-zh.md) |
| 想看北极星架构而不是当前实现 | [technical-architecture-zh.md](/Volumes/WD1T/outsea/backliner-helper/technical-architecture-zh.md) 和 [technical-architecture-diagrams-zh.md](/Volumes/WD1T/outsea/backliner-helper/technical-architecture-diagrams-zh.md) |

## 当前实现边界

- 当前 repo 已经支持：
  - 严格串行的单站队列原语
  - worker lease + 浏览器 ownership lock
  - 外部 Chrome shared CDP
  - replay / scout / finalization
  - account registry
  - 本地加密 credential vault
  - 注册型站点的邮箱 alias 策略
- 当前 repo 还没有完全自动化：
  - 独立 watchdog 进程
  - OpenClaw 自动创建调度
  - 通用 OAuth worker
  - 完整的 `gog` 自动恢复 runner
- 所以当前最准确的定位是：
  - **repo = 可调度的执行底座**
  - **operator skill = 真正的运行入口**
