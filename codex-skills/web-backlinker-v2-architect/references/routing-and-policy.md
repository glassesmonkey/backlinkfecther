# Routing And Policy

用这份文档处理 route 优先级、policy gating 和业务边界。

## Default Route Priority

默认按这个顺序选路：

1. `replay_site_playbook`
2. `reuse_email_account`
3. `direct_submit`
4. `register_email_account`
5. `page_understanding`
6. `agent_live_takeover`
7. `park`

原则是先复用，再探索；先轻路径，再重路径；只有在低成本证据仍不足时才进入 live takeover。

## Planning Inputs

选路时至少考虑：
- 是否已有高置信 playbook
- 是否已有可复用账号
- auth 类型
- anti-bot 类型
- 是否需要 reciprocal backlink
- 是否存在 deeper submit surface
- OAuth 是否被 policy 允许

规划结果至少应给出：
- `route`
- `execution_mode`
- `automation_disposition`
- `next_action`
- `rationale`

## Policy Gates

以下内容不能由自动化默认拍板：
- 付费 listing
- reciprocal backlink
- founder / phone / address 等敏感披露
- 未授权 OAuth
- 人工验证码协助策略

这类问题应明确 park 到 `WAITING_POLICY_DECISION`、`WAITING_MISSING_INPUT` 或 `WAITING_MANUAL_AUTH`。

## Anti-Bot Handling

- 遇到硬风控时，确认后 skip 或 park。
- 不做破解，不做死循环重试。
- 对软验证码只允许谨慎尝试，且应记录证据和结果。

## Live Takeover Rules

- `agent_live_takeover` 只作为最终兜底层触发，不作为默认主路径。
- live takeover 必须带时间预算、动作预算和轨迹记录。
- live takeover 成功后，优先沉淀 trajectory playbook，而不是继续堆 adapter 规则。
- live takeover 看到明显业务阻塞时，不继续死磕，应切换到明确等待态。

## Routing Smells

看到这些信号时，应先怀疑选路设计：
- 默认优先 OAuth，而不是先复用邮箱资产。
- 遇到不确定页面时直接继续乱点，而不是升级。
- 让 business policy 和 page understanding 混在一起判断。
- 用无限 takeover 掩盖糟糕的等待态建模或失败分流。
