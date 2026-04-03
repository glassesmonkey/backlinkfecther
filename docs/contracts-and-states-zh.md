# 契约与状态

## 这份文档解决什么问题

告诉你当前系统会产出哪些 JSON、有哪些状态、每个字段是什么意思，以及它们落在哪些路径。

## 什么时候读

- 想读 task JSON，但不知道字段代表什么。
- 想新增一个状态或 `wait_reason_code`。
- 想确认 artifact、playbook、profile 存在哪。

## 最后验证对象

- `/Volumes/WD1T/outsea/backliner-helper/src/shared/types.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/memory/data-store.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/execution/takeover.ts`

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
| `data/backlink-helper/runs/` | `latest-preflight.json` 等运行清单 |
| `data/backlink-helper/runtime/` | 共享浏览器锁、managed browser 元信息 |

## 类型总表

### `BrowserRuntime`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `cdp_url` | `string` | 当前要连接的 CDP 入口 |
| `ok` | `boolean` | 运行时是否通过主检查 |
| `source` | `BrowserRuntimeSource` | 这个 `cdp_url` 从哪里来的 |
| `browser_name` | `string` | `/json/version` 返回的浏览器名 |
| `protocol_version` | `string` | DevTools Protocol 版本 |
| `preflight_checks` | object | 五项检查结果 |

`BrowserRuntimeSource` 当前可能值：

- `cli`
- `BACKLINK_BROWSER_CDP_URL`
- `BROWSER_USE_CDP_URL`
- `CHROME_CDP_URL`
- `autodiscovered_external`
- `default_local`

### `TaskRecord`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | `string` | task 唯一 ID |
| `target_url` | `string` | 当前要提交的目录站 URL |
| `hostname` | `string` | `target_url` 对应 hostname |
| `submission` | `SubmissionContext` | 当前提交上下文 |
| `status` | `TaskStatus` | 当前状态 |
| `created_at` | `string` | 创建时间 |
| `updated_at` | `string` | 最近更新时间 |
| `run_count` | `number` | 这个 task 被跑过几次 |
| `escalation_level` | `"none" | "replay" | "scout" | "takeover"` | 当前跑到哪层 |
| `takeover_attempts` | `number` | takeover 次数 |
| `last_takeover_at` | `string?` | 最近一次 takeover 时间 |
| `last_takeover_outcome` | `string?` | 最近一次 takeover 结论 |
| `trajectory_playbook_ref` | `string?` | 当前使用或生成的 playbook key |
| `terminal_class` | `TerminalClass?` | 当前终态分类标签 |
| `skip_reason_code` | `string?` | 明确跳过时的结构化原因 |
| `wait` | `WaitMetadata?` | 等待态元信息 |
| `phase_history` | `string[]` | 跑过哪些阶段 |
| `latest_artifacts` | `string[]` | 最近产生的 artifact 路径 |
| `notes` | `string[]` | 面向人读的摘要说明 |

`phase_history` 当前常见值：

- `scout`
- `takeover:agent-loop`
- `takeover:finalization`

### `WaitMetadata`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `wait_reason_code` | `string` | 结构化等待原因 |
| `resume_trigger` | `string` | 自动恢复条件，或审计终态说明 |
| `resolution_owner` | `"system" | "gog" | "none"` | 由系统恢复、由 `gog` 恢复，或不恢复 |
| `resolution_mode` | `"auto_resume" | "terminal_audit"` | 自动恢复态还是审计终态 |
| `evidence_ref` | `string` | 证据文件路径 |

### `TrajectoryPlaybook`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | `string` | playbook ID |
| `hostname` | `string` | 站点 key |
| `capture_source` | `"manual" | "agent_live_takeover"` | 这个 playbook 从哪来 |
| `surface_signature` | `string` | 生成时的页面特征 |
| `preconditions` | `string[]` | replay 前提 |
| `steps` | `ReplayStep[]` | 可重放动作 |
| `anchors` | `string[]` | replay 锚点 |
| `postconditions` | `string[]` | replay 结束后应该看到什么 |
| `success_signals` | `string[]` | 哪些文本代表成功 |
| `fallback_notes` | `string[]` | replay 失败后怎么退回 |
| `replay_confidence` | `number` | 当前 replay 信心 |
| `distilled_from_trace_ref` | `string?` | 这份 playbook 来自哪个 agent trace |
| `agent_backend` | `string?` | 生成它的 agent backend |
| `created_at` | `string` | 创建时间 |
| `updated_at` | `string` | 最近更新时间 |

### `AgentDecision`

这是 agent backend 每一步必须返回的结构化动作。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `action` | `AgentDecisionAction` | 下一步要执行什么 |
| `url` | `string?` | `open_url` 时使用 |
| `index` | `number?` | `click_index / input_index / select_index` 时使用 |
| `text` | `string?` | `input_index` 文本 |
| `value` | `string?` | `select_index` 选项值 |
| `keys` | `string?` | `keys` 动作要发送的按键 |
| `wait_kind` | `"text" | "selector"?` | `wait` 动作类型 |
| `wait_target` | `string?` | 等待目标 |
| `wait_timeout_ms` | `number?` | 等待超时 |
| `wait_state` | `"attached" | "detached" | "visible" | "hidden"?` | selector wait 的状态 |
| `next_status` | `TaskStatus?` | 分类终态时要落到哪个状态 |
| `wait_reason_code` | `string?` | 分类或等待原因 |
| `resume_trigger` | `string?` | 自动恢复条件，或终态解释 |
| `resolution_owner` | `"system" | "gog" | "none"?` | 谁负责恢复 |
| `resolution_mode` | `"auto_resume" | "terminal_audit"?` | 自动恢复还是审计终态 |
| `terminal_class` | `TerminalClass?` | 终态语义标签 |
| `skip_reason_code` | `string?` | 明确跳过原因 |
| `detail` | `string?` | 给 artifact 和 task notes 的简要说明 |
| `reason` | `string` | 这一步为什么这么做 |
| `confidence` | `number` | 这一步的信心 |
| `expected_signal` | `string` | 预期看到什么变化 |
| `stop_if_observed` | `string[]` | 如果出现这些信号就该停止当前思路 |

### `AgentLoopTrace`

这是 agent-first 主链的核心 artifact。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `task_id` | `string` | 对应 task |
| `agent_backend` | `string` | 本次使用的 backend |
| `started_at` | `string` | loop 开始时间 |
| `finished_at` | `string` | loop 结束时间 |
| `stop_reason` | `string` | 为什么停止 |
| `final_url` | `string` | 停止时 URL |
| `final_title` | `string` | 停止时页面标题 |
| `final_excerpt` | `string` | 停止时页面文本摘要 |
| `steps` | `AgentLoopTraceStep[]` | 每一步 observation / decision / execution |

### `ScoutResult`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `ok` | `boolean` | scout 是否成功进入页面 |
| `surface_summary` | `string` | 一句话地形说明 |
| `field_hints` | `string[]` | 猜到的字段类信息 |
| `auth_hints` | `string[]` | 猜到的登录类信息 |
| `anti_bot_hints` | `string[]` | 猜到的反爬类信息 |
| `submit_candidates` | `string[]` | 可能的 submit 按钮文本 |
| `evidence_sufficiency` | `boolean` | 当前文本证据是否足够支持下一步 |
| `page_snapshot` | `PageSnapshot` | 当前页面快照 |

### `TakeoverResult`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `ok` | `boolean` | takeover 是否落到“可接受的正向状态” |
| `next_status` | `TaskStatus` | takeover 完成后的状态 |
| `detail` | `string` | 一句话结论 |
| `artifact_refs` | `string[]` | takeover 相关 artifact |
| `wait` | `WaitMetadata?` | 如需等待，挂这里 |
| `terminal_class` | `TerminalClass?` | 当前终态或结果分类 |
| `skip_reason_code` | `string?` | 当状态为 `SKIPPED` 时使用 |
| `playbook` | `TrajectoryPlaybook?` | 如可复用，附带返回 |
| `agent_trace_ref` | `string?` | 当前结果引用的 agent trace |
| `agent_backend` | `string?` | 当前结果来自哪个 backend |
| `agent_steps_count` | `number?` | agent loop 总步数 |

## 状态总表

### `TaskStatus`

| 状态 | 当前语义 |
| --- | --- |
| `READY` | 任务已创建，还没进入本轮执行 |
| `RUNNING` | 当前正在执行 |
| `WAITING_EXTERNAL_EVENT` | 自动可恢复等待，如邮箱验证 |
| `WAITING_POLICY_DECISION` | 审计终态，表示命中了付费、CAPTCHA 或其他策略边界 |
| `WAITING_MISSING_INPUT` | 审计终态，表示当前输入集不足 |
| `WAITING_MANUAL_AUTH` | 审计终态，表示遇到无人值守不支持的认证流程 |
| `WAITING_SITE_RESPONSE` | 自动可恢复等待，表示已提交、待目录站审核/发布 |
| `RETRYABLE` | 当前失败，但后续还有重试价值 |
| `DONE` | 已完成 |
| `SKIPPED` | 已明确跳过 |

## 当前已发射的 `wait_reason_code`

| code | 典型状态 | 说明 |
| --- | --- | --- |
| `DIRECTORY_NAVIGATION_FAILED` | `RETRYABLE` | scout 连站都没进去 |
| `DIRECTORY_UPSTREAM_5XX` | `RETRYABLE` | 目录站上游 5xx |
| `BROWSER_USE_CLI_UNAVAILABLE` | `RETRYABLE` | 新站默认执行器不可用 |
| `AGENT_BACKEND_UNAVAILABLE` | `RETRYABLE` | agent backend 配置不完整或不支持 |
| `CAPTCHA_BLOCKED` | `WAITING_POLICY_DECISION` | 站点要求 CAPTCHA / bot verification |
| `DIRECTORY_LOGIN_REQUIRED` | `WAITING_MANUAL_AUTH` | 必须先登录 |
| `PAID_OR_SPONSORED_LISTING` | `WAITING_POLICY_DECISION` | 明显付费 / 赞助要求 |
| `EMAIL_VERIFICATION_PENDING` | `WAITING_EXTERNAL_EVENT` | 等邮箱验证 |
| `SITE_RESPONSE_PENDING` | `WAITING_SITE_RESPONSE` | 已提交，等待站点返回最终结果 |
| `OUTCOME_NOT_CONFIRMED` | `RETRYABLE` | 页面没给出明确成功或失败信号 |
| `REQUIRED_INPUT_MISSING` | `WAITING_MISSING_INPUT` | 当前输入集不够 |
| `TAKEOVER_RUNTIME_ERROR` | `RETRYABLE` | takeover 自己崩了 |

## 当前 artifact 类型

| artifact 类型 | 文件名模式 | 来源 |
| --- | --- | --- |
| scout JSON | `{taskId}-scout.json` | `runLightweightScout()` |
| agent loop JSON | `{taskId}-agent-loop.json` | `runAgentDrivenBrowserUseLoop()` |
| agent loop 截图 | `{taskId}-agent-loop.png` | `runAgentDrivenBrowserUseLoop()` |
| finalization JSON | `{taskId}-finalization.json` | `runTakeoverFinalization()` |
| finalization 截图 | `{taskId}-finalization.png` | `runTakeoverFinalization()` |
| replay 截图 | `{name}.png` | `runTrajectoryReplay()` 里的 `screenshot` step |
| preflight 清单 | `runs/latest-preflight.json` | `pnpm preflight` |
| 浏览器锁 | `runtime/browser-ownership-lock.json` | ownership lock |

## 当前已识别的终态类别

这是给 casebook 和 playbook 用的“语义标签”，不是 `TaskStatus` 枚举本身。

| terminal class | 当前来源 |
| --- | --- |
| `login_required` | takeover 页面明确要求登录 |
| `captcha_blocked` | takeover 页面卡在 CAPTCHA |
| `paid_listing` | 登录后或提交后进入 pricing / sponsor / checkout |
| `upstream_5xx` | 目录站自身不可用 |
| `outcome_not_confirmed` | 页面没给出可确认结果 |
| `takeover_runtime_error` | takeover 逻辑本身崩了 |

## 无人值守语义提醒

- `WAITING_POLICY_DECISION / WAITING_MISSING_INPUT / WAITING_MANUAL_AUTH` 仍然保留为细分 `TaskStatus`，但它们是为了审计和报表，不是为了等待人类恢复。
- 真正会自动恢复的只有 `WAITING_EXTERNAL_EVENT` 和 `WAITING_SITE_RESPONSE`。
- 如果代码或文档里再次出现“人工完成后继续 RUNNING”，就说明控制层已经偏回半自动模式了。

## 契约使用提醒

- 如果你要新增状态，先改 `src/shared/types.ts`，再改 `takeover.ts` 和文档。
- 如果你要新增新的等待原因，先给 `wait_reason_code` 起稳定名字，再更新这里和 casebook。
- 如果你想让“站点规律”在下次复用，就不要只写 `notes`，要写进 playbook 或 casebook。
