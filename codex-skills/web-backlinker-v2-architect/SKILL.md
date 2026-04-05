---
name: web-backlinker-v2-architect
description: Web Backlinker V2.1 架构守门与实现约束。Use when Codex needs to design, implement, refactor, or review Web Backlinker V2.1 components such as task store, four-layer memory, trajectory playbooks, live browser takeover, waiting-state modeling, reporter, or watchdog logic while preserving task-first state, memory-first reuse, evidence-sufficiency escalation, bounded browser takeover, and bounded recovery.
---

# Web Backlinker V2 Architect

## Overview

守住 Web Backlinker V2 的架构边界，再讨论实现细节。
先把问题归类到正确模块，再读取最少量参考资料，最后输出方案、评审意见或拆解建议。

## Repo Docs Source of Truth

当问题已经落到当前实现，而不是停留在北极星架构层时，以 repo 文档为准：

- `/Volumes/WD1T/outsea/backliner-helper/README.md`
- `/Volumes/WD1T/outsea/backliner-helper/docs/ops-runbook-zh.md`
- `/Volumes/WD1T/outsea/backliner-helper/docs/code-map-and-data-flow-zh.md`
- `/Volumes/WD1T/outsea/backliner-helper/docs/contracts-and-states-zh.md`
- `/Volumes/WD1T/outsea/backliner-helper/docs/site-casebook-zh.md`

使用规则：

- 运行方式、CLI 命令、shared CDP 浏览器接入，以 repo docs 为准。
- 当前生产主链已经切到 `OpenClaw/operator skill -> claim-next-task -> task-prepare -> Codex-driven browser-use CLI -> task-record-agent-trace -> task-finalize`，不要再按旧的 `run-next + API backend` 心智给建议。
- 当前状态枚举、`wait_reason_code`、artifact 路径、playbook 形状，以 repo docs 为准。
- 已验证过的目录站结论、付费页判断、建议跳过策略，以 repo casebook 为准。
- 这份 skill 继续只保留架构不变量、review checklist 和 reference routing，不再重复 repo 的完整运行细节。

## Core Invariants

先检查这五条。如果任意一条被破坏，优先指出风险并回退到正确架构。

1. 保持 `task-first`。把一个 target site 视为一个独立、可恢复、可统计的任务，不要把整轮 campaign 写成一个长浏览器会话。
2. 保持 `memory-first`。把一次运行沉淀成 promoted-site profile、site playbook、account registry、submission ledger 四层记忆，不要只留下零散日志。
3. 保持 `bounded browser takeover`。允许 Agent 在最终兜底层短时接管浏览器，但必须带预算、轨迹记录、停止条件，并能回到主状态机。
4. 保持 `evidence sufficiency first`。先问当前证据是否足以支持一个确定动作，再决定是否升级到 Page Understanding，不要用异常白名单硬编码升级。
5. 保持 `bounded recovery`。拆开 worker、reporter、watchdog，只做有界恢复，不要无限重试或让健康检查侵入执行链。

业务红线同样是硬约束：
- 不绕过高级反爬、Cloudflare、Turnstile、reCAPTCHA、hCaptcha 或其他 managed challenge。
- 不自动做付费提交、互链接受、隐私敏感披露等业务决策。
- 不编造 promoted-site 信息。
- 不在 playbook、account registry、artifact、日志中保存明文 secrets。

## Workflow

按这个顺序工作：

1. 先归类问题。
2. 再读取最少量 reference。
3. 再确认涉及的契约、状态、边界条件。
4. 最后输出设计、实现拆解、review 结论或重构建议。

输出时始终显式说明：
- 当前问题属于哪个 plane 或模块。
- 哪条不变量最容易被破坏。
- 需要读取哪个 reference。
- 最小可行改动是什么。
- 哪些内容必须保持不变。

## Reference Routing

按问题类型读取对应 reference，不要默认全读。

- 修改主执行链、模块分层、数据如何在系统中流动时，先读 [references/runtime-topology.md](references/runtime-topology.md)。
- 修改或新增 profile、playbook、account、ledger 持久化时，先读 [references/memory-model.md](references/memory-model.md)。
- 修改 task 状态、claim/checkpoint/finish、锁、恢复语义时，先读 [references/task-state-machine.md](references/task-state-machine.md)。
- 修改 route 选择、policy gating、反爬处理、付费/互链边界时，先读 [references/routing-and-policy.md](references/routing-and-policy.md)。
- 修改 lightweight scout、Page Understanding、live browser takeover、artifact、decision schema 时，先读 [references/page-understanding.md](references/page-understanding.md)。
- 修改 batch、reporter、watchdog、bounded recovery 时，先读 [references/ops-and-recovery.md](references/ops-and-recovery.md)。
- 需要最小 JSON 形状、字段含义、示例记录时，先读 [references/contracts-and-examples.md](references/contracts-and-examples.md)。
- 做总体验收、原则审查、架构 review 时，先读 [references/principles.md](references/principles.md)。

## Decision Tree

用最短路径决定先看什么：

- 改任务推进逻辑，读 `task-state-machine.md`。
- 改记忆持久化，读 `memory-model.md`。
- 改选路或业务边界，读 `routing-and-policy.md`。
- 改复杂页面升级链，读 `page-understanding.md`。
- 改无人值守链路，读 `ops-and-recovery.md`。
- 改整体分层或模块职责，读 `runtime-topology.md`。
- 需要字段契约或示例 JSON，读 `contracts-and-examples.md`。

## Review Checklist

做设计或代码 review 时，逐项检查：

1. 这个改动有没有把任务粒度从“单 target”退化成“大流程”？
2. 这个改动有没有新增或破坏四层记忆的职责边界？
3. 这个改动有没有让浏览器接管失去预算、轨迹或停止条件？
4. 这个改动有没有把“证据不足”简化成“命中异常列表”？
5. 这个改动有没有让 watchdog 或 reporter 直接操纵 worker 主状态？
6. 这个改动有没有越过业务或安全边界？
7. 这个改动之后，最小 JSON 契约是否仍然清晰、可审计、可恢复？

## Anti-Patterns

发现以下模式时，直接指出并要求回退：

- 把浏览器会话当唯一状态源。
- 让 Agent 在没有时间预算、动作预算、回收机制的情况下长期接管浏览器。
- 用异常白名单替代 `evidence sufficiency`。
- 把 reporter 或 watchdog 塞进 worker 主链。
- 在 playbook、account、artifact、日志里写明文 secrets。
- 对硬风控做死循环重试。
- 让成功经验只停留在自然语言日志里，不写回结构化记忆。
- 把 live takeover 成功后的经验只记成自然语言笔记，而不沉淀为结构化 trajectory playbook。

## Output Expectations

输出建议时，默认采用这个格式：

- 问题归类：属于哪个 plane / module
- 受影响不变量：哪条原则最关键
- 需要的 reference：只列最相关的 1-3 个
- 建议方案：最小、可恢复、可审计
- 契约变化：涉及哪些状态、字段或 artifact
- 风险与边界：不能越过什么

如果用户要求实现方案，先给行为级结构与数据契约，再给代码级建议。不要在未确认契约前直接展开长代码。

## Non-Goals

这份 skill v1 不负责：

- 生成 adapter / provider 模板代码
- 提供真实执行脚本
- 指导验证码绕过
- 提供品牌资源、图标、样式资产
- 自动隐式注入到所有上下文
