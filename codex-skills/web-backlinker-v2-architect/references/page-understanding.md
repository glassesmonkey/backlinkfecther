# Page Understanding

用这份文档处理 lightweight scout、证据充足性、Page Understanding 和 live takeover 升级链。

## Core Question

不要先问“有没有命中某个异常类”。
先问这三个问题：

1. 下一步动作是否明确？
2. 动作位置是否明确？
3. 动作后的预期状态是否明确？

只要有一个不明确，就升级到 Page Understanding。

## Evidence Sources

优先使用便宜证据：
- HTTP scout
- DOM summary
- compile hints
- surface summary
- iframe summary
- lightweight scout 的 field / control inspection

便宜证据足够时，直接走 deterministic action。

## Lightweight Scout Responsibilities

`lightweight scout` 至少负责：
- 收集交互控件
- 识别 field map
- 区分 submit control、entry CTA、signup、login
- 识别 iframe surface
- 计算 `evidence_sufficiency`
- 在证据不足时推荐升级

它不再承担主提交职责。

## Artifact Shape

Page Understanding artifact 至少包含：
- task summary
- policy summary
- promoted-site summary
- plan summary
- execution summary
- page evidence
- agent job instructions
- orchestration commands

目标是让 Agent 拿到 takeover 前的“小而够用案卷”，缩短 live takeover 的探索成本。

## Decision Shape

Agent 输出应是结构化 decision，而不是自由文本建议。

最少包含：
- `page_kind`
- `recommended_path`
- `candidate_actions`
- `terminal_reason`
- `evidence`

`candidate_actions` 最好可被 deterministic executor 消费；如果仍不足，应显式推荐升级到 `agent_live_takeover`。

## Live Takeover

如果 Page Understanding 后仍然无法确定提交路径，就升级到 `agent_live_takeover`。

live takeover 的要求：
- Agent 可直接查看并操作 live browser
- takeover 只在预算内运行
- 每次 takeover 都要写 trajectory artifact
- 成功后沉淀 trajectory playbook
- 失败后按等待态或终止态明确分流

默认预算：
- 最长 8 分钟
- 最多 40 个浏览器动作
- 每个 task 最多 2 次 takeover，且需要出现明确状态变化才允许再次触发

## Non-Negotiable Rule

Page Understanding 不是浏览器驾驶层；`agent_live_takeover` 才是最终兜底驾驶层。

正确链路是：
1. execution-core / lightweight scout 判断证据不足
2. 生成 artifact
3. Agent 输出 decision JSON
4. 如果仍不能收敛，就升级到 `agent_live_takeover`
5. takeover 在预算内探索并提交或明确分流
6. 回到主状态机并更新 playbook / ledger / waits

如果一个方案让 Agent 无预算、无轨迹、无回收地长期探索浏览器，它就偏离了这个系统的核心设计。
