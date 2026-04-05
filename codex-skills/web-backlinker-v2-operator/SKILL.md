---
name: web-backlinker-v2-operator
description: Run one bounded Backliner Helper site task inside the current Codex/OpenClaw session. Use when Codex should claim the next queued directory task, prepare the site, drive browser-use CLI against the shared CDP browser, consume gog email verification or magic links, record the agent trace, finalize the result with Playwright, and update playbooks, account registry, and the credential vault without relying on an external API backend.
---

# Web Backlinker V2 Operator

## Overview

这是运行 skill，不是架构 skill。

你负责在当前 Codex/OpenClaw 会话里，完成 **一个** bounded site task，然后退出。
不要自己发明新的运行协议，先按 repo 当前的单站点 worker 原语执行。

## Repo Docs Source of Truth

先读这几份：

- `/Volumes/WD1T/outsea/backliner-helper/README.md`
- `/Volumes/WD1T/outsea/backliner-helper/docs/ops-runbook-zh.md`
- `/Volumes/WD1T/outsea/backliner-helper/docs/contracts-and-states-zh.md`
- `/Volumes/WD1T/outsea/backliner-helper/docs/site-casebook-zh.md`

如果 repo docs 和旧对话记忆冲突，以 repo docs 为准。

## Run Contract

每次运行只做一个网站任务：

1. `claim-next-task`
2. 无任务就退出
3. `task-prepare`
4. 若 `mode = replay_completed` 或 `task_stopped`，退出
5. 若 `mode = ready_for_agent_loop`，由你直接驱动 `browser-use CLI`
6. 跑完后写 `agent-loop` trace payload
7. `task-record-agent-trace`
8. `task-finalize`
9. 退出

不要在一个会话里 claim 第二个任务。

## Bounded Worker Rules

- 单任务硬上限：10 分钟
- 默认最大动作数：120
- 同一 surface 重复 4 次就停
- 同一动作重复 3 次就停
- 连续 12 步没有新证据就停
- 命中明确终态立即停

如果你停下时还没有明确成功，也必须产出结构化 trace 和 handoff，不允许无痕失败。

## Browser Rules

- 使用 repo 已连接的 shared CDP 浏览器
- 默认用 `browser-use CLI` 做探索和交互
- `Playwright` 只留给 repo 的 replay 和 finalization
- 不要自己绕过 repo 的 lease / ownership 语义

## Account Strategy

注册型站点的默认路线：

```text
reuse_site_account
-> if missing: register_email_account
-> plus alias
-> site password
-> gog verification or magic link
-> finalize
```

执行规则：

- 如果 `task-prepare` 返回 `account_candidate` 和 `account_credentials`，优先复用
- 如果 `registration_required = true` 且没有账号：
  - 优先用 `registration_email_alias`
  - 为目录站自身注册生成一个站点密码
  - 密码只放进 trace payload 的 `account.credential_payload`
  - 不要把密码写进 notes、playbook、artifact 正文

## gog Rules

邮箱验证是正式主路径，不是补救路径。

遇到验证码或 magic link：

- 优先用 `mailbox_query`
- 调 `gog gmail messages search ... --json --results-only --max=1 --include-body --no-input`
- 找到邮件后，必要时再调 `gog gmail get <messageId> --json --results-only --format=full --no-input`
- 继续当前同一任务

如果当前预算内还没等到邮件：

- 结束当前任务
- 让 repo 维持 `WAITING_EXTERNAL_EVENT`

## Unattended Boundaries

允许：

- 既有登录态复用
- Google chooser
- consent / continue
- 目录站自己的注册密码
- 邮箱验证码 / magic link

禁止：

- Google 密码输入
- 2FA / passkey / 手机确认
- CAPTCHA bypass
- 付费决策

命中禁止边界时，不要继续 wandering。  
应当在 trace/handoff 中明确分类为：

- `WAITING_MANUAL_AUTH`
- `WAITING_POLICY_DECISION`
- `WAITING_MISSING_INPUT`
- 或 `SKIPPED`

## Trace Payload

在调用 `task-record-agent-trace` 之前，准备一个 JSON payload 文件，结构固定为：

- `trace`
  - `task_id`
  - `agent_backend = "codex_session"`
  - `started_at`
  - `finished_at`
  - `stop_reason`
  - `final_url`
  - `final_title`
  - `final_excerpt`
  - `steps`
- `handoff`
  - `detail`
  - `artifact_refs`
  - `current_url`
  - `recorded_steps`
  - `agent_trace_ref`
  - `agent_backend = "codex_session"`
  - `agent_steps_count`
  - `proposed_outcome?`
- `account?`
  - 仅当本轮创建或更新了账号才附带
  - 包含 `hostname/email/email_alias/auth_mode/verified/login_url/submit_url/credential_ref?/credential_payload?/last_registration_result`

`recorded_steps` 要尽量写成将来可 replay 的稳定动作。

## Output Expectations

默认按这个顺序向用户更新：

- claim 到了哪个 task
- prepare 结果是什么
- 是否进入注册路线 / gog 路线
- 最终状态分类
- 是否生成了 playbook / account / credential_ref

如果当前没有任务，直接说明 `claim-next-task` 返回了空队列即可。
