# 契约与状态

## 这份文档解决什么问题

告诉你当前系统会产出哪些 JSON、有哪些 lease 和状态、账号与凭据放在哪，以及它们各自的字段含义。

## 什么时候读

- 想读 task JSON，但不知道字段代表什么。
- 想新增 queue/lease/account/vault 字段。
- 想确认 artifact、playbook、account、credential 分别存在哪。

## 最后验证对象

- `/Volumes/WD1T/outsea/backliner-helper/src/shared/types.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/memory/data-store.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/control-plane/task-queue.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/control-plane/task-prepare.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/control-plane/task-finalize.ts`

## 数据落盘路径

根目录：

- `data/backlink-helper/`

当前目录结构：

| 路径 | 用途 |
| --- | --- |
| `data/backlink-helper/tasks/` | 每个 task 一份 JSON |
| `data/backlink-helper/artifacts/` | scout / agent-loop / finalization 结果和截图 |
| `data/backlink-helper/playbooks/sites/` | 同域 trajectory playbook |
| `data/backlink-helper/profiles/` | promoted site profile |
| `data/backlink-helper/accounts/` | 站点 account registry |
| `data/backlink-helper/vault/` | 本地加密 credential vault |
| `data/backlink-helper/runs/` | `latest-preflight.json` 等运行清单 |
| `data/backlink-helper/runtime/` | worker lease、浏览器锁、pending finalization |

## 类型总表

### `TaskRecord`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | `string` | task 唯一 ID |
| `target_url` | `string` | 当前目录站 URL |
| `hostname` | `string` | 站点 key |
| `submission` | `SubmissionContext` | promoted profile + base email + confirm flag |
| `status` | `TaskStatus` | 当前状态 |
| `run_count` | `number` | 这个 task 跑过几次 |
| `takeover_attempts` | `number` | takeover 次数 |
| `trajectory_playbook_ref` | `string?` | 使用或生成的 playbook key |
| `account_ref` | `string?` | 对应的站点 account key |
| `lease_expires_at` | `string?` | 当前 bounded worker lease 到期时间 |
| `terminal_class` | `TerminalClass?` | 结果语义标签 |
| `skip_reason_code` | `string?` | 明确跳过原因 |
| `wait` | `WaitMetadata?` | 等待态元信息 |
| `phase_history` | `string[]` | 已跑过的阶段 |
| `latest_artifacts` | `string[]` | 最近 artifact 路径 |
| `notes` | `string[]` | 面向人读的摘要 |

### `WaitMetadata`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `wait_reason_code` | `string` | 结构化等待原因 |
| `resume_trigger` | `string` | 自动恢复条件，或审计终态说明 |
| `resolution_owner` | `"system" | "gog" | "none"` | 谁负责恢复 |
| `resolution_mode` | `"auto_resume" | "terminal_audit"` | 自动恢复态还是审计终态 |
| `evidence_ref` | `string` | 证据文件路径 |

### `WorkerLease`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `task_id` | `string` | 当前 lease 持有的 task |
| `owner` | `string` | 这次 bounded worker 的 owner 标识 |
| `acquired_at` | `string` | claim 时间 |
| `expires_at` | `string` | lease 过期时间 |

### `AccountRecord`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `hostname` | `string` | 站点 key |
| `email` | `string` | 基础邮箱地址 |
| `email_alias` | `string` | 本站实际注册邮箱 |
| `auth_mode` | `password_email \| email_code \| magic_link \| google_oauth` | 登录方式 |
| `verified` | `boolean` | 账号是否已完成验证 |
| `login_url` | `string?` | 登录入口 |
| `submit_url` | `string?` | 提交入口 |
| `credential_ref` | `string?` | 指向 vault 的引用 |
| `created_at` | `string` | 首次创建时间 |
| `last_used_at` | `string` | 最近一次使用时间 |
| `last_registration_result` | `string` | 最近一次注册结果摘要 |

### `CredentialVaultRecord`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `credential_ref` | `string` | 凭据键 |
| `encrypted_payload` | `string` | AES-GCM 加密后的 payload |
| `created_at` | `string` | 首次写入时间 |
| `updated_at` | `string` | 最近更新时间 |

注意：

- account registry 只存 `credential_ref`
- 明文密码绝不进：
  - task
  - artifact
  - playbook
  - notes
  - account registry

### `PrepareResult`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `mode` | `"replay_completed" \| "ready_for_agent_loop" \| "task_stopped"` | prepare 结果 |
| `task` | `TaskRecord` | 最新 task 快照 |
| `effective_target_url` | `string` | canonical 化后的目标 URL |
| `replay_hit` | `boolean` | 是否命中过 playbook replay |
| `scout_artifact_ref` | `string?` | scout artifact 路径 |
| `scout` | `ScoutResult?` | scout 结果 |
| `account_candidate` | `AccountRecord?` | 已存在的站点账号 |
| `account_credentials` | `CredentialPayload?` | 解密后的凭据，仅 operator 使用 |
| `registration_required` | `boolean?` | 当前看起来是否需要先注册 |
| `registration_email_alias` | `string?` | 建议使用的 plus alias |
| `mailbox_query` | `string?` | 建议给 `gog` 用的 Gmail query |

### `AgentTraceEnvelope`

这是 operator skill 写回 repo 的桥接载体。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `trace` | `AgentLoopTrace` | Codex 驱动的浏览器 trace |
| `handoff` | `TakeoverHandoff` | 给 finalization 的收口信息 |
| `account` | `AccountDraft?` | 本轮若新建了账号，带回注册结果和待保存凭据 |

### `FinalizeResult`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `next_status` | `TaskStatus` | finalization 后的任务状态 |
| `detail` | `string` | 一句话结论 |
| `artifact_refs` | `string[]` | finalization 产生的 artifact |
| `playbook` | `TrajectoryPlaybook?` | 如可复用，则返回 |
| `account_created` | `boolean?` | 本轮是否写入了 account registry |
| `credential_ref` | `string?` | 若保存了凭据，对应的 vault key |

## 状态总表

| 状态 | 当前语义 |
| --- | --- |
| `READY` | 已入队，尚未被当前 bounded worker claim |
| `RUNNING` | 当前正在执行 |
| `WAITING_EXTERNAL_EVENT` | 自动可恢复等待，如邮箱验证码 / magic link |
| `WAITING_POLICY_DECISION` | 审计终态，如付费、赞助、CAPTCHA |
| `WAITING_MISSING_INPUT` | 审计终态，输入集不足 |
| `WAITING_MANUAL_AUTH` | 审计终态，遇到 Google 密码、2FA 等不支持认证 |
| `WAITING_SITE_RESPONSE` | 自动可恢复等待，已提交待审核 |
| `RETRYABLE` | 当前失败，但还有一次自动重试价值 |
| `DONE` | 已完成 |
| `SKIPPED` | 已明确跳过 |

## 当前 `wait_reason_code`

| code | 典型状态 | 说明 |
| --- | --- | --- |
| `TASK_TIMEOUT` | `RETRYABLE` | 上一轮 bounded worker 超时 |
| `DIRECTORY_NAVIGATION_FAILED` | `RETRYABLE` | scout 连站都没进去 |
| `DIRECTORY_UPSTREAM_5XX` | `RETRYABLE` | 目录站上游 5xx |
| `BROWSER_USE_CLI_UNAVAILABLE` | `RETRYABLE` | 新站默认执行器不可用 |
| `GOG_UNAVAILABLE` | `RETRYABLE` | 注册/邮箱验证路线需要 `gog`，但当前不可用 |
| `EMAIL_VERIFICATION_PENDING` | `WAITING_EXTERNAL_EVENT` | 等邮箱验证码 / magic link |
| `EMAIL_PARSE_FAILED` | `RETRYABLE` | 邮件到了，但当前解析失败 |
| `EMAIL_ALIAS_REJECTED` | 中间事件 | plus alias 被站点拒绝，需要回退基础邮箱 |
| `SITE_RESPONSE_PENDING` | `WAITING_SITE_RESPONSE` | 已提交，等待站点响应 |
| `PAID_OR_SPONSORED_LISTING` | `WAITING_POLICY_DECISION` | 明显付费 / 赞助要求 |
| `CAPTCHA_BLOCKED` | `WAITING_POLICY_DECISION` | 站点要求 CAPTCHA |
| `DIRECTORY_LOGIN_REQUIRED` | `WAITING_MANUAL_AUTH` | 需要不受支持的登录/认证 |
| `REQUIRED_INPUT_MISSING` | `WAITING_MISSING_INPUT` | 当前输入集不足 |
| `OUTCOME_NOT_CONFIRMED` | `RETRYABLE` | 页面没给出明确成功/失败信号 |
| `TAKEOVER_RUNTIME_ERROR` | `RETRYABLE` | takeover 自己崩了 |

## 当前 artifact 类型

| artifact 类型 | 文件名模式 | 来源 |
| --- | --- | --- |
| scout JSON | `{taskId}-scout.json` | `task-prepare` |
| agent loop JSON | `{taskId}-agent-loop.json` | `task-record-agent-trace` |
| finalization JSON | `{taskId}-finalization.json` | `task-finalize` |
| finalization 截图 | `{taskId}-finalization.png` | `task-finalize` |
| preflight 清单 | `runs/latest-preflight.json` | `pnpm preflight` |
| worker lease | `runtime/task-worker-lease.json` | queue claim/reaper |
| 浏览器锁 | `runtime/browser-ownership-lock.json` | phase ownership |
| pending finalization | `runtime/{taskId}-pending-finalize.json` | `task-record-agent-trace` |

## 无人值守提醒

- 真正自动恢复的只有 `WAITING_EXTERNAL_EVENT` 和 `WAITING_SITE_RESPONSE`。
- `WAITING_POLICY_DECISION / WAITING_MISSING_INPUT / WAITING_MANUAL_AUTH` 是审计终态，不是“等人类补刀”的运行态。
- 当前主路径不再依赖 `OPENAI_API_KEY`；真正的运行入口是 operator skill，而不是 repo-native API backend。
