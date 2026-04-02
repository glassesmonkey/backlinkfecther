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
| `data/backlink-helper/artifacts/` | scout / probe / browser-use / takeover 结果和截图 |
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
| `preflight_checks` | object | 四项检查结果 |

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
| `wait` | `WaitMetadata?` | 等待态元信息 |
| `phase_history` | `string[]` | 跑过哪些阶段 |
| `latest_artifacts` | `string[]` | 最近产生的 artifact 路径 |
| `notes` | `string[]` | 面向人读的摘要说明 |

`phase_history` 当前常见值：

- `scout`
- `takeover:probe`
- `takeover:browser-use`
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
| `created_at` | `string` | 创建时间 |
| `updated_at` | `string` | 最近更新时间 |

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
| probe JSON | `{taskId}-probe.json` | `runPlaywrightUltraLightProbe()` |
| probe 截图 | `{taskId}-probe.png` | `runPlaywrightUltraLightProbe()` |
| browser-use JSON | `{taskId}-browser-use.json` | `runBrowserUseFallback()` |
| browser-use 截图 | `{taskId}-browser-use.png` | `runBrowserUseFallback()` |
| takeover JSON | `{taskId}-takeover.json` | `runTakeoverFinalization()` |
| takeover 截图 | `{taskId}-takeover.png` | `runTakeoverFinalization()` |
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
