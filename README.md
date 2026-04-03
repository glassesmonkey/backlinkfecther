# Backliner Helper

## 这份文档解决什么问题

告诉你这套系统现在是什么、怎么跑第一条命令、遇到问题先看哪份文档。

## 什么时候读

- 第一次接手这个 repo。
- 想确认“skill”和“代码”分别负责什么。
- 想在 Mac 上用外部 Chrome 跑一次真实任务。

## 最后验证对象

- `/Volumes/WD1T/outsea/backliner-helper/src/cli/index.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/control-plane/run-next.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/agent/decider.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/agent/openai-decider.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/shared/browser-runtime.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/shared/preflight.ts`

## 这是什么

Backliner Helper 采用“双架构”：

- `repo 代码` 负责执行。它真的去连接浏览器、跑 `preflight`、侦察目录站、填写表单、更新任务状态、写 artifact。
- `skill` 负责架构守门。它约束 Codex 后续设计、实现、review 时不要把系统写回一次性脚本。

当前这份 README 和 `docs/` 下文档是实现层唯一主真相源。  
全局 skill 只负责规则和入口，不再复制完整运行细节。

## 调用链

```text
你
 -> repo CLI
 -> shared CDP browser
 -> directory site / gog

Codex
 -> skill
 -> repo docs
 -> repo code
```

## 最短可运行路径

### 1. 启动一个外部 Chrome

这是当前最推荐的模式。浏览器由你手动启动，CLI 只去连接它。

```bash
open -na "/Applications/Google Chrome.app" --args \
  --remote-debugging-port=9223 \
  '--remote-allow-origins=*' \
  --user-data-dir=/tmp/chrome-cdp \
  about:blank
```

先确认 CDP 真的开出来了：

```bash
curl http://127.0.0.1:9223/json/version
```

### 2. 让项目连这个浏览器

```bash
cd /Volumes/WD1T/outsea/backliner-helper
export BACKLINK_BROWSER_CDP_URL=http://127.0.0.1:9223
export OPENAI_API_KEY=...
pnpm preflight
```

如果你想改模型或自定义 endpoint，再加这些变量：

```bash
export BACKLINER_AGENT_MODEL=gpt-5
export OPENAI_BASE_URL=https://api.openai.com/v1
```

### 3. 跑一个单任务

```bash
pnpm run-next -- \
  --task-id demo-futuretools \
  --directory-url https://futuretools.io/ \
  --promoted-url https://exactstatement.com/ \
  --submitter-email support@exactstatement.com \
  --confirm-submit
```

说明：

- 如果不显式设置 `BACKLINK_BROWSER_CDP_URL`，系统会先尝试自动发现外部 Chrome，优先探测 `9222 / 9223 / 9224 / 9229`。
- `run-next` 是当前最重要的执行入口。它会跑 `preflight -> replay -> scout -> agent-driven browser-use CLI loop -> Playwright finalization -> task/artifact update`。
- 当前对“新站点”的默认策略是 **agent-first**：
  - 有高置信 playbook 才直接 replay
  - 没有 playbook 就进入 `browser-use CLI` 的 agent loop
  - `Playwright` 只保留 replay 和证据收口
- 如果 `browser-use CLI` 或 agent backend 没配置好，`run-next` 会在真正执行前把 task 标成 `RETRYABLE`，而不是半路崩掉。

## 当前代码地图

- `src/cli/`
  - 终端入口。负责解析参数并调用控制面。
- `src/control-plane/`
  - 执行编排。负责 `preflight`、task lifecycle、replay/scout/agent loop/finalization 的顺序。
- `src/agent/`
  - agent 决策层。负责把浏览器当前状态变成下一步结构化动作。
- `src/execution/`
  - 具体浏览器动作。包括 `scout`、agent loop 执行器、`replay`、浏览器写锁、最终收口。
- `src/memory/`
  - 本地 JSON 落盘。包括 task、artifact、playbook、profile 的路径和读写。
- `src/shared/`
  - 跨模块基础能力。包括 CDP 运行时解析、Playwright 连接、preflight、类型定义。

## 先看哪份文档

| 你现在的问题 | 先看哪份 |
| --- | --- |
| 想先跑起来 | [docs/ops-runbook-zh.md](docs/ops-runbook-zh.md) |
| 想改执行链或浏览器接入 | [docs/code-map-and-data-flow-zh.md](docs/code-map-and-data-flow-zh.md) |
| 想知道状态、字段、artifact 长什么样 | [docs/contracts-and-states-zh.md](docs/contracts-and-states-zh.md) |
| 想知道某个目录站之前发生过什么 | [docs/site-casebook-zh.md](docs/site-casebook-zh.md) |
| 想看北极星架构而不是当前实现 | [technical-architecture-zh.md](technical-architecture-zh.md) 和 [technical-architecture-diagrams-zh.md](technical-architecture-diagrams-zh.md) |

## 当前实现边界

- 当前 CLI 已经支持：
  - 外部 Chrome 优先的 shared CDP 模式
  - `preflight`
  - `scout`
  - `trajectory replay`
  - `agent-driven browser-use CLI` 主执行链
  - Playwright evidence finalization
  - task / artifact / promoted profile 落盘
- 当前 CLI 还没有稳定支持：
  - 通用 OAuth 自动化引擎
  - 完整的 `gog` 自动恢复链
  - reporter / watchdog CLI
  - 高置信的 agent trace 到 replay playbook 自动蒸馏
- 所以请把两份架构稿理解为 `north star`，把这份 README 和 `docs/` 理解为“当前真正在跑的版本”。
