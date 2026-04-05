# 运行手册

## 这份文档解决什么问题

告诉你当前版本怎么跑单站点 bounded worker、怎么判断一个任务是否该继续、以及最常见的环境问题怎么排查。

## 什么时候读

- 想第一次在本机跑通。
- 想把它接进 OpenClaw cron。
- 想看某个任务为什么落到 `WAITING_* / RETRYABLE / SKIPPED`。

## 最后验证对象

- `/Volumes/WD1T/outsea/backliner-helper/src/cli/index.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/control-plane/task-queue.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/control-plane/task-prepare.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/control-plane/task-finalize.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/shared/preflight.ts`

## 运行原则

当前版本锁定 5 条运行原则：

- 一次只处理 **1 个网站任务**
- 单任务硬上限 **10 分钟**
- OpenClaw/skill 是入口，不是 repo-native agent backend
- 新站默认由 Codex 直接驱动 `browser-use CLI`
- `Playwright` 只保留 `replay + finalization`

## 环境准备

### 1. 外部 Chrome

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

### 2. 环境变量

```bash
cd /Volumes/WD1T/outsea/backliner-helper
export BACKLINK_BROWSER_CDP_URL=http://127.0.0.1:9223
export BACKLINER_VAULT_KEY='replace-with-a-stable-secret'
pnpm preflight
```

可选但推荐：

- 提前让 `gog` 完成邮箱授权
- 继续复用单独的 Chrome profile，不要连日常主力浏览器

## Skill 源码和安装副本

当前项目已经把 skill 源码收回 repo：

- repo source：`/Volumes/WD1T/outsea/backliner-helper/codex-skills/`
- runtime install：`/Users/gc/.codex/skills/`

运行规则固定为：

- 改 skill 时只改 repo source
- 改完先跑 `pnpm validate-skills`
- 再跑 `pnpm sync-skills`
- 不把 `/Users/gc/.codex/skills/web-backlinker-v2-*` 当成常规源码目录

常用命令：

```bash
pnpm validate-skills
pnpm validate-skills --installed
pnpm sync-skills
pnpm diff-skills
```

## 当前生产主链

```text
OpenClaw cron
-> $web-backlinker-v2-operator
-> claim-next-task
-> task-prepare
-> Codex-driven browser-use CLI loop
-> gog (if needed)
-> task-record-agent-trace
-> task-finalize
-> exit
```

`run-next` 仍能本地调试，但不是推荐生产入口。

## CLI 原语

### `enqueue-site`

用途：

- 把一个网站任务写成 `READY`

示例：

```bash
pnpm enqueue-site -- \
  --task-id demo-futuretools \
  --directory-url https://futuretools.io/ \
  --promoted-url https://exactstatement.com/ \
  --submitter-email-base support@exactstatement.com \
  --confirm-submit
```

### `claim-next-task`

用途：

- 挑出下一个可执行任务
- 写入 `task-worker-lease.json`
- 顺手完成最小 reaper

返回模式：

- `claimed`
- `idle`
- `lease_held`

### `task-prepare`

用途：

- 做 preflight
- 尝试 replay
- 做 scout
- 修正 canonical URL
- 给 operator skill 返回：
  - 是否需要 agent loop
  - 是否可能是注册型站点
  - 推荐的 email alias 和 mailbox query
  - 是否已有可复用站点账号

### `task-record-agent-trace`

用途：

- 把 operator skill 产生的浏览器探索 trace 落盘
- 写入 `{taskId}-agent-loop.json`
- 写入一个 pending finalization payload，供 `task-finalize` 使用

### `task-finalize`

用途：

- 用 Playwright 连接共享浏览器
- 做最终截图、结果分类、playbook 规范化
- 更新 account registry / credential vault
- 释放 worker lease 和浏览器锁

## 注册型站点怎么跑

当前正式策略：

```text
reuse_site_account
-> 若无账号则 register_email_account
-> 用 plus alias 注册
-> 自动生成站点密码
-> gog 读取验证码 / magic link
-> 验证完成
-> 写 account registry
-> 写 credential vault
-> 下次同站优先复用账号
```

边界：

- 允许：
  - 目录站自己的注册密码
  - 邮箱验证码
  - magic link
  - Google chooser / consent
- 禁止：
  - Google 密码输入
  - 2FA / passkey / 手机确认
  - CAPTCHA bypass
  - 付费决策

## `gog` 的角色

`gog` 现在不再只是未来设计，它是注册路线的正式能力。

典型用法：

```bash
gog gmail messages search "to:name+futuretools@example.com newer_than:7d" --json --results-only --max=1 --include-body --no-input
```

如果拿到了 message id，再取内容：

```bash
gog gmail get <messageId> --json --results-only --format=full --no-input
```

当前 repo 已经提供 `src/shared/gog.ts` 作为 helper 基础，但生产主路径仍由 operator skill 调 `gog`。

## 怎么读任务结果

### 自动恢复态

- `WAITING_EXTERNAL_EVENT`
  - 等邮箱验证码 / magic link
- `WAITING_SITE_RESPONSE`
  - 已提交，等站点审核或发布

### 审计终态

- `WAITING_POLICY_DECISION`
  - 付费、赞助、CAPTCHA、业务边界
- `WAITING_MANUAL_AUTH`
  - Google 密码、2FA、可疑登录验证等
- `WAITING_MISSING_INPUT`
  - 当前输入集不够

### 可重试

- `RETRYABLE`
  - 超时
  - 上游 5xx
  - `gog` 不可用
  - 邮件解析失败
  - 结果无法确认

## 常见故障排查

### 1. `claim-next-task` 总是返回 `lease_held`

先看：

- `data/backlink-helper/runtime/task-worker-lease.json`
- `data/backlink-helper/runtime/browser-ownership-lock.json`

如果 lease 还没过期，说明上一轮 bounded worker 还没释放。  
如果 lease 已过期，下一次 `claim-next-task` 会自动 reaper，并把旧任务改成 `RETRYABLE + TASK_TIMEOUT`。

### 2. `task-prepare` 返回 `GOG_UNAVAILABLE`

说明当前任务很可能是注册型站点，但 `gog` 不可用。  
先修环境，再继续，不要让 agent 先冲到邮箱验证再卡住。

### 3. plus alias 被站点拒绝

当前策略是：

- 先试 `name+hostname@example.com`
- 若站点明确拒绝，再回退主邮箱原地址

不要把 plus alias rejection 误判成“站点不可注册”。

### 4. 付费页不是提交失败

如果登录后落到：

- `Stripe`
- `checkout`
- `listed-now`
- `submit pay`

这不叫“执行器坏了”，而是已经走到了真实业务终点。  
当前正确处理是 `WAITING_POLICY_DECISION`，并写 casebook/playbook。

### 5. `OPENAI_API_KEY` 缺失

这对当前生产主路径不是硬阻塞。  
当前生产主路径是 **Codex/OpenClaw 会话驱动**，不是 repo-native API backend。
