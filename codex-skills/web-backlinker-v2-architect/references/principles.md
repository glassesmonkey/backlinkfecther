# Web Backlinker V2 Principles

先用这份文档判断改动方向是否正确，再看其他 reference。

## Five Architectural Invariants

1. `task-first`
   把一个 target site 视为一个独立任务。每个任务都必须能 claim、checkpoint、finish、retry、park。
2. `memory-first`
   把运行结果沉淀为长期资产，而不是只留下自然语言日志。最少保留 promoted-site profile、site playbook、account registry、submission ledger。
3. `bounded browser takeover`
   允许 Agent 在最终兜底层短时接管浏览器，但必须有时间预算、动作预算、轨迹记录和停止条件。不能出现无限接管或无法回收的会话。
4. `evidence sufficiency first`
   先问证据是否足以支持一个确定动作，再决定是否升级。不要靠枚举异常类来驱动升级。
5. `bounded recovery`
   让 worker、reporter、watchdog 各司其职。恢复必须有界、可解释、可停止。

## Business Boundaries

- 不自动绕过高级反爬、验证码或 managed challenge。
- 不自动做付费提交、互链接受、敏感披露等业务决策。
- 不编造 promoted-site 信息。缺字段时先补 profile 或 intake。
- 不重复提交同一个 promoted site 到同一个 target。

## Secret Handling

- 不在 playbook 中保存密码或 token 明文。
- 不在 account registry 中保存 secrets 明文。
- 不在 artifact 和日志中回显 secrets。
- 只保存引用、profile ref、browser profile ref、mailbox ref 之类的间接标识。

## Review Rule

任何方案只要破坏这五条架构原则之一，就不要继续优化局部实现，先修正整体设计。
