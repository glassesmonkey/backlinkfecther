# Memory Model

用这份文档约束四层记忆的职责、写入时机和禁区。

## Promoted-Site Profile

解决“写什么”。

应保存：
- canonical URL
- product name
- one-liner
- short / medium description
- category / tags
- use cases
- pricing / privacy / contact
- disclosure boundaries

应在 run 早期完成，作为所有后续表单填写的事实来源。

## Site Playbook

解决“这个站点怎么投”。

应保存：
- `capture_source`
- 入口 URL
- auth route
- surface signature
- 前置条件
- 结构化 trajectory steps
- anchors
- postconditions
- 成功信号 / 失败信号
- anti-bot 或 captcha 观察结果
- replay confidence 或稳定性判断

V2.1 中 playbook 的主要来源不再是 adapter 推断，而是成功的 live takeover 轨迹沉淀。
只有在观察到足够稳定的路径时才提升为高置信 playbook。

## Account Registry

解决“用哪个账号做”。

应保存：
- domain
- account ref
- signup email
- auth type
- browser profile ref
- mailbox ref
- status

只保存引用，不保存密码明文。

## Submission Ledger

解决“还要不要做”。

应保存：
- promoted URL
- target domain
- target normalized URL
- state
- run_id / task_id
- listing_url 或外部结果引用

它是 cross-run dedupe 的硬约束，不是可选提示。

## Write Rules

- 成功提交后，至少更新 ledger。
- 发现可复用账号后，更新 account registry。
- 形成稳定站点路径后，更新 trajectory playbook。
- profile 缺字段时，不要胡写，先补 profile 或 intake。

## Forbidden Shortcuts

- 不用自然语言日志代替结构化记忆。
- 不把 task store 当作四层记忆的替代品。
- 不让单个 artifact 同时承担 playbook 和 ledger 的职责。
- 不把 live takeover 的成功经验只记成一段自由文本。
