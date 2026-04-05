# Task State Machine

用这份文档处理任务状态、恢复语义、锁和 checkpoint。

## Core States

- `READY`
  可以立即 claim。
- `RUNNING`
  已被 worker claim，当前正推进。
- `WAITING_EXTERNAL_EVENT`
  流程推进到 email verification、magic link 或其他可由系统自动恢复的外部事件，等待 `gog` 或轮询信号。
- `WAITING_POLICY_DECISION`
  已触达业务决策点，但在无人值守模式里它是审计终态，不等待人工恢复。
- `WAITING_MISSING_INPUT`
  还缺文案、分类、资产、授权边界等输入，无法继续自动推进；它是审计终态。
- `WAITING_MANUAL_AUTH`
  需要密码、2FA、设备确认或其他不可自动化认证动作；它是审计终态。
- `WAITING_SITE_RESPONSE`
  已完成站点侧提交，等待站点审核、发布或外部处理结果。
- `RETRYABLE`
  当前失败不是终止失败，可以延后再试。
- `DONE`
  已提交、已验证、已存在或其他完成态。
- `SKIPPED`
  明确终止，不值得继续自动推进。

## Required Operations

任务系统至少支持：
- `init`
- `claim`
- `checkpoint`
- `finish`
- `summary`
- `release-stale`

每个等待态都必须带：
- `wait_reason_code`
- `resume_trigger`
- `resolution_owner`
- `resolution_mode`
- `evidence_ref`

## Locking Rules

每个 task 都应有：
- `locked_by`
- `lock_expires_at`

worker 异常退出后，系统必须能识别 stale lock，把 `RUNNING` 回收到 `RETRYABLE` 或其他明确状态，不能永久卡死。

## Transition Rules

- `READY -> RUNNING`：正常 claim。
- `RETRYABLE -> RUNNING`：重试 claim。
- `WAITING_EXTERNAL_EVENT -> RUNNING`：邮件、magic link 或其他外部事件到达后继续。
- `WAITING_SITE_RESPONSE -> RUNNING`：站点结果返回且需要继续处理时恢复。
- `RUNNING -> DONE`：提交完成、验证完成、已存在。
- `RUNNING -> WAITING_EXTERNAL_EVENT`：等待邮箱、magic link 或其他自动可恢复事件。
- `RUNNING -> WAITING_POLICY_DECISION`：遇到付费、互链、敏感披露、captcha 等策略边界，进入审计终态。
- `RUNNING -> WAITING_MISSING_INPUT`：明确缺少必需输入，进入审计终态。
- `RUNNING -> WAITING_MANUAL_AUTH`：明确需要密码、2FA 或其他无人值守不支持的认证动作，进入审计终态。
- `RUNNING -> WAITING_SITE_RESPONSE`：已提交，等待外站审核或发布。
- `RUNNING -> RETRYABLE`：瞬时失败、证据不足后延迟重试、stale recovery。
- `RUNNING -> SKIPPED`：硬风控、死路、终止性跳过。

## State Modeling Rules

- 把自动可恢复的邮箱或回调等待放进 `WAITING_EXTERNAL_EVENT`，不要保留在 `RUNNING`。
- 把业务决策、缺输入、人工认证、外站审核拆开，不要重新收敛成一个泛化等待态。
- `WAITING_POLICY_DECISION / WAITING_MISSING_INPUT / WAITING_MANUAL_AUTH` 是细分审计终态，不是人工恢复态。
- 不要把所有失败都收敛成一个 `FAILED`。
- 不要把锁状态隐含在浏览器进程里。
