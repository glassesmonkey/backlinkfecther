# Web Backlinker V2.1 技术架构说明

> 当前 repo 的运行方式、状态契约、站点案例和维护入口，请先看 [README.md](README.md) 与 [docs/](docs/) 下文档。
> 这份文件继续保留为 `north star` 架构说明，不等价于当前代码实现细节。

> 面向对象：想理解或复刻这套系统的工程负责人、技术合伙人、架构师。
>
> 一句话定义：**Web Backlinker V2.1 不是一个“自动填表脚本”，而是一套“带长期记忆、可恢复、可观测、按任务队列推进，并在最终兜底层允许 Agent 有预算接管浏览器”的目录站/外链提交流水线。**

## 目录

1. [背景与问题定义](#1-背景与问题定义)
2. [核心设计目标](#2-核心设计目标)
3. [总体设计思路](#3-总体设计思路)
4. [系统分层架构](#4-系统分层架构)
5. [核心数据模型](#5-核心数据模型)
6. [核心组件与职责](#6-核心组件与职责)
7. [完整业务流程](#7-完整业务流程)
8. [任务状态机与恢复机制](#8-任务状态机与恢复机制)
9. [路由选择与执行策略](#9-路由选择与执行策略)
10. [浏览器执行架构](#10-浏览器执行架构)
11. [Page Understanding 升级机制](#11-page-understanding-升级机制)
12. [无人值守运行：batch、reporter、watchdog](#12-无人值守运行batchreporterwatchdog)
13. [安全边界与业务边界](#13-安全边界与业务边界)
14. [为什么 V2 比“普通自动化”更强](#14-为什么-v2-比普通自动化更强)
15. [如果合作伙伴要复刻，建议怎么落地](#15-如果合作伙伴要复刻建议怎么落地)
16. [总结](#16-总结)

---

## 1. 背景与问题定义

传统“外链提交自动化”一般有四个致命问题：

### 1.1 每次都从零开始

很多脚本的思路是：
- 读一个 target list
- 打开浏览器
- 找表单
- 填表
- 提交

问题在于：**这套过程没有记忆。**

于是第二次再跑同一个站点时，系统还是要重新判断：
- 这个站点的 submit 入口在哪
- 要不要登录
- 能不能走邮箱注册
- 有没有验证码
- 之前是不是已经提交过

这会导致边际成本不下降。

### 1.2 浏览器会话成了唯一状态来源

很多 agent/browser 自动化把“当前 tab 的上下文”当成系统唯一真相。

这会导致：
- 会话一断就丢进度
- 中途报错难恢复
- 无法把一次成功沉淀成未来可复用路径
- 运行结果散落在日志里，不能形成结构化资产

### 1.3 一个站点卡住，会拖死整个批次

实际外链任务里，一个 target 往往会遇到：
- 邮箱验证
- OAuth 登录
- 付费墙
- Cloudflare / Turnstile / reCAPTCHA
- 内容型投稿页而不是标准 submit form
- iframe / Tally / Typeform 嵌入表单

如果系统没有任务级状态机，就会出现：
- 一个站点卡住，整轮流程停住
- 重试时又从头跑
- 人工难以接管

### 1.4 没有可观测性与无人值守能力

即使跑起来，也常见这些问题：
- 不知道现在整体跑到哪了
- 不知道是不是“看起来在跑，实际已经卡死”
- 不知道哪些结果是成功、待人工、待重试
- 没有独立的健康检查与恢复机制

---

## 2. 核心设计目标

Web Backlinker V2 的设计目标可以概括成六条。

### 2.1 让后续运行比首次运行更便宜

这是第一原则。

系统必须把一次运行中学到的东西沉淀成可复用资产，包括：
- 被推广网站的资料包
- 每个目标站点的提交 playbook
- 已注册账号
- 已提交记录

**第一次是学习，后面是复用。**

### 2.2 把“一个目标站点”建模成一个可恢复任务

不是把一整个 campaign 当作一个巨型浏览器流程。

而是：
- 一个 target URL = 一个任务
- 每个任务独立状态
- 每个任务可以 claim / checkpoint / finish
- 一个任务失败不会影响其他任务推进

### 2.3 低层确定性优先，最终兜底允许有预算接管

这套系统的默认原则仍然是：

- **低成本证据层**：用 scout / hints / artifact 尽量缩小问题空间
- **执行层**：优先用可复放、可审计的动作去 replay 或推进

但 V2.1 不再把“Agent 绝不能直接操作浏览器”视为硬规则。

它新增了一层：

- **最终兜底层**：当 artifact 之后仍无法判断提交路径时，允许 Agent 在**有时间预算、有动作预算、有轨迹记录、有停止条件**的前提下短时接管浏览器

核心原则变成：

> 默认分离，必要时 bounded takeover。

### 2.4 优先使用便宜证据，不够再升级到 live page review

默认先走便宜、快的证据：
- HTTP scout
- DOM summary
- compile hints
- surface summary

只有当这些证据**不足以支持“一个确定的下一步动作”**时，才升级到 Page Understanding。

这叫：

> **Evidence sufficiency first**，而不是“遇到某几个异常类才升级”。

### 2.5 无人值守时可持续推进，但等待态必须可操作

系统要支持 unattended run，但要有边界：
- 能自动推进的继续推进
- 自动可恢复的阻塞 park 到 `WAITING_EXTERNAL_EVENT`
- 需要人工决策、缺失输入、人工认证、站点审核分别进入不同等待态
- 遇到硬风控不要死磕
- 进度汇报和健康检查必须独立于 worker

### 2.6 业务上有明确红线

系统明确不做：
- 高级反爬/验证码绕过
- 自动付费提交
- 自动接受 reciprocal backlink
- 编造产品信息
- 把明文密码写进 playbook 或日志

---

## 3. 总体设计思路

从第一性原理看，这套系统本质上由四个问题组成：

1. **我要推广什么？**
   - promoted-site profile
2. **我要投到哪里？**
   - target list + task store
3. **这个站点怎么投？**
   - scout + playbook + account memory + route planning
4. **怎么稳定地长期跑？**
   - batch worker + reporter + watchdog

所以 V2 不是“单次浏览器自动化”，而是一个小型操作系统：

- 有状态存储
- 有任务队列
- 有路由器
- 有执行引擎
- 有监控
- 有恢复机制
- 有长期记忆

可以把它理解为：

```text
Promoted Site Memory
        +
Target Site Memory
        +
Task Queue / State Machine
        +
Browser Execution Engine
        +
Monitoring & Recovery
        =
Web Backlinker V2
```

---

## 4. 系统分层架构

## 4.1 逻辑分层

```text
┌──────────────────────────────────────────────┐
│                Operator / User               │
│   提供 promoted URL、策略边界、目标列表、授权   │
└──────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│            Control Plane / Orchestration     │
│ bootstrap_runtime / init_intake / run_next   │
│ run_batch / select_execution_plan            │
└──────────────────────────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Memory Plane │ │ Execution    │ │ Ops Plane    │
│              │ │ Plane        │ │              │
│ profile      │ │ scout        │ │ reporter     │
│ playbook     │ │ browser tools│ │ watchdog     │
│ accounts     │ │ takeover     │ │ cron jobs    │
│ ledger       │ │ replay       │ │ health check │
└──────────────┘ └──────────────┘ └──────────────┘
        │             │             │
        └─────────────┴─────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│              Runtime Artifacts               │
│ task store / manifest / scout / brief / plan │
│ execution result / page-understanding bundle │
└──────────────────────────────────────────────┘
```

## 4.2 四大平面

### A. Control Plane（控制面）

负责“流程编排”，不直接承担浏览器细节。

主要脚本：
- `bootstrap_runtime.py`
- `init_intake.py`
- `run_next.py`
- `run_batch.py`
- `select_execution_plan.py`

职责：
- 创建 run
- 校验 intake 是否完整
- 控制任务 claim / finish / retry
- 决定走什么 route
- 决定何时升级到 page understanding 或 agent live takeover

### B. Memory Plane（记忆面）

负责让后续运行更便宜。

主要资产：
- promoted-site profile
- site playbook
- account registry
- submission ledger

职责：
- 记住产品资料
- 记住某站点怎么提交
- 记住某站点账号能否复用
- 防止对同一 target 重复提交

### C. Execution Plane（执行面）

负责真正“去网页上做动作”。

主要模块：
- `packages/execution-core/src/cli.js`
- lightweight scout（轻量侦察层）
- browser control tools（Playwright executor + browser-use fallback）
- live takeover loop（最终兜底接管层）
- trajectory replay（复用层）

职责：
- 选择执行器和 fallback 工具
- 用低成本侦察收集 hints
- 在必要时触发 live takeover
- replay 成功过的 trajectory playbook
- 返回结构化结果，而不是一堆零散日志

### D. Ops Plane（运维面）

负责无人值守、汇报和恢复。

主要模块：
- `report_progress.py`
- `watchdog_status.py`
- reporter cron
- watchdog cron

职责：
- 独立进度汇报
- 独立健康检查
- 检测 stale locks / worker stall / report lag
- 只做**有界恢复**，不无限重试

---

## 5. 核心数据模型

## 5.1 Run Manifest

Manifest 是一轮 campaign 的控制中枢。

它记录：
- run_id
- promoted_url
- 当前状态
- intake 状态
- reporting/watchdog 配置
- preflight 结果
- 运行路径

简化示意：

```json
{
  "run_id": "20260330T165926-example-run",
  "promoted_url": "https://example.com",
  "status": "READY",
  "intake": {
    "required_missing": []
  },
  "reporting": {
    "enabled": true,
    "interval_minutes": 30,
    "cron_job_id": "..."
  },
  "watchdog": {
    "enabled": true,
    "worker_cron_job_id": "...",
    "cron_job_id": "..."
  },
  "preflight": {
    "browser_executor": "playwright",
    "browser_fallback_tool": "browser-use-cli",
    "ready_for_real_submit": true
  },
  "paths": {
    "task_store_path": "...",
    "profile_path": "...",
    "artifacts_dir": "..."
  }
}
```

## 5.2 Task Store

Task Store 是任务队列，也是任务真相源。

每个 target 一条 task，核心字段包括：
- task_id / row_id
- normalized_url / domain
- status / phase
- attempts
- auth_type / anti_bot / captcha_tier
- route / execution_mode / automation_disposition
- playbook_id / account_ref
- submission_url / listing_url
- lock 信息
- notes

简化示意：

```json
{
  "task_id": "task-0042",
  "normalized_url": "https://target-site.com/submit",
  "domain": "target-site.com",
  "status": "READY",
  "phase": "imported",
  "attempts": 0,
  "auth_type": "unknown",
  "anti_bot": "unknown",
  "route": "",
  "playbook_id": "",
  "account_ref": "",
  "notes": []
}
```

## 5.3 Promoted-site Profile

这是“被推广网站资料包”，是所有提交内容的事实来源。

它至少要包含：
- canonical URL
- product name
- one-liner
- short/medium description
- category / tags
- use cases
- pricing/privacy/contact
- 可用邮箱
- 披露边界

本质上，它是：

> **系统可被允许写出去的产品事实集合。**

## 5.4 Site Playbook

这是每个 target site 的长期记忆。

它记录：
- 入口 URL
- auth route
- 字段映射
- 稳定步骤
- 成功信号 / 失败信号
- captcha/anti-bot 策略
- 复放置信度

核心目的：

> 下次再遇到同站点时，直接复放，而不是重新侦察。

## 5.5 Account Registry

记录一个 target site 上已经存在的账号。

只保存引用，不保存明文 secrets。

字段通常包括：
- domain
- account_ref
- signup email
- auth_type
- browser_profile_ref
- mailbox_account
- status

## 5.6 Submission Ledger

这是防重系统。

如果同一个 promoted site 已经向同一个 target 提交过，新的 run 应该直接跳过或 park，而不是重新 discover。

关键字段：
- promoted_url
- target_domain
- target_normalized_url
- state
- run_id / task_id
- listing_url

---

## 6. 核心组件与职责

## 6.1 `bootstrap_runtime.py`

职责：初始化一轮 run 的目录结构和 manifest。

会创建：
- `accounts/`
- `artifacts/`
- `playbooks/`
- `profiles/`
- `runs/`
- `tasks/`
- `reports/`
- `submission-ledger.json`

它解决的是：

> “这一轮 campaign 的运行空间和控制文件怎么组织？”

## 6.2 `probe_promoted_site.py`

职责：先理解被推广站点，而不是急着去碰 target site。

这是非常关键的一步。

如果连 promoted site 自己的：
- 名称
- 描述
- 分类
- 联系方式
- 定价/隐私页

都不完整，就不应该开始真实提交。

## 6.3 `init_intake.py`

职责：收集提交前的业务边界和身份边界。

它的价值不是“多一个表单”，而是防止系统在 live flow 中途才发现：
- 没有授权邮箱
- 不允许 OAuth
- 不允许人工验证码接管
- 不允许付费 listing
- 不允许披露 founder / phone / address

所以它是一个**gating layer**。

如果 intake 不完整，run 不应进入真实提交流程。

## 6.4 `task_store.py`

职责：实现任务级状态管理。

支持动作包括：
- init
- claim
- checkpoint
- finish
- summary
- release-stale

这是整个系统恢复能力的核心。

没有这个模块，所有“断点续跑”“单行恢复”“watchdog 放锁”都无从谈起。

## 6.5 `select_execution_plan.py`

职责：根据 task 当前状态 + playbook + account + intake，决定下一步 route。

它本质上是个路由器。

它会综合判断：
- 是否已有高置信 playbook
- 是否已有账号可复用
- auth 类型是什么
- anti-bot 是不是硬风控
- 是否要求 reciprocal backlink
- 是否有 deeper submit surface
- OAuth 是否被 policy 允许

然后输出：
- route
- execution_mode
- automation_disposition
- next_action
- rationale

## 6.6 `run_next.py`

这是单个任务的主执行入口。

完整链路是：
1. claim 一个 task
2. scout target
3. checkpoint scout 结果
4. 必要时 scaffold playbook
5. select execution plan
6. 生成 worker brief
7. 调 execution-core 执行
8. 如果需要，生成 page-understanding artifact
9. finish task
10. 更新 ledger

它是全链路的 orchestrator。

## 6.7 `packages/execution-core`

这是浏览器执行层。

V2.1 里，它不再以 adapter 为主，而是拆成四层：

### Lightweight Scout
处理“先用便宜证据看看这个站点大概怎么提”。

包含：
- surface inspection
- field hints
- entry CTA / iframe / paid / challenge 识别
- evidence sufficiency 计算

它的职责是**缩小搜索空间**，不是负责最终提交。

### Browser Control Tools
处理“通过哪个浏览器执行栈去做”的问题。

包含：
- `Playwright`
- `browser-use-cli` fallback
- `dry-run`

### Live Takeover
处理“Page Understanding 之后仍无法判断路径时，如何让 Agent 在预算内直接接管浏览器”。

默认预算：
- 最长 8 分钟
- 最多 40 个动作
- 每个 task 最多 2 次 takeover

### Trajectory Replay
处理“如何复放一次成功过的接管轨迹”。

这样做的好处是：
- 便宜证据与高成本探索解耦
- 浏览器驱动与提交策略解耦
- 成功经验能沉淀成 playbook 并优先复放
- 能在不改 planner 的情况下调整执行器和 fallback 工具

## 6.8 `prepare_page_understanding.py` / live takeover loop

这是 V2.1 的关键升级点。

它们把“复杂页面的语义整理”和“最终兜底层浏览器接管”拆开：

- `prepare_page_understanding.py`：把当前任务打包成结构化 artifact
- Agent：先基于 artifact 输出结构化 decision
- live takeover loop：如果 decision 仍不足以给出提交路径，就进入带预算的浏览器接管
- trajectory recorder：把成功或失败的接管过程沉淀成 artifact 和 playbook 候选

## 6.9 `report_progress.py`

职责：只读汇报，不碰 worker 状态。

它会：
- 汇总 task counts
- 找出最近变化的 task
- 生成中文总结
- 写 markdown 快照
- backlog 清空时写 final report
- 统计各等待态数量、takeover 成功率和超时恢复情况

## 6.10 `watchdog_status.py`

职责：做本地 deterministic health check。

它关注：
- task counts
- 最新进展时间
- stale RUNNING rows
- batch lock 是否卡住
- reporter 是否滞后
- run 是否还有 backlog
- live takeover 是否卡死
- `WAITING_EXTERNAL_EVENT` 是否超时未恢复

它不负责真正执行 worker，而负责**判断是否该恢复、怎么恢复**。

---

## 7. 完整业务流程

下面是从 0 到 1 的完整业务流程。

## 7.1 启动 run

输入：
- campaign name
- promoted URL

动作：
- 运行 `bootstrap_runtime.py`
- 创建 manifest / artifacts / reports / tasks 等目录
- 预先跑 preflight

输出：
- 一个新的 run workspace

## 7.2 构建 promoted-site 资料包

动作：
- 运行 `probe_promoted_site.py`
- 抽取产品名、描述、分类、价格页、隐私页、联系邮箱等

输出：
- promoted-site profile

意义：
- 后续所有对外表单填写都从这份 profile 取值
- 避免 agent 临场编造内容

## 7.3 Intake 闸门

动作：
- 运行 `init_intake.py`
- 收集缺失字段与 policy 边界

如果缺字段：
- 不进入真实提交流程
- 只允许补齐 intake，不允许真实提交

意义：
- 防止系统边跑边猜政策边界

## 7.4 目标列表导入与去重

动作：
- `task_store.py init`
- 导入 target URLs
- 结合 submission ledger 做 cross-run dedupe

效果：
- 已经提交过的 target 直接 `SKIPPED`
- 新 target 标记为 `READY`

## 7.5 预飞检查

动作：
- `preflight.py`

确认：
- shared CDP 是否通
- `browser-use` 是否可用
- `gog` 是否可用
- Playwright 执行器和 fallback 工具是否齐备
- 是否 ready for real submit

意义：
- 在 worker 启动前决定执行栈，而不是执行到一半再换浏览器体系

## 7.6 Worker claim 单行任务

动作：
- `run_next.py` claim 一个 task
- 写锁
- 状态改成 `RUNNING`

原则：
- 一次只处理一行
- 处理完立即 finish 或 park

## 7.7 Target Scout

动作：
- `scout_target.py`

目标：
- 识别 site type
- 识别 auth type
- 识别 anti-bot
- 找 submit 入口
- 找表单字段
- 识别 reciprocal backlink 要求

原则：
- 只侦察到“足够路由”为止
- 不过度侦察

## 7.8 首次站点记忆初始化

如果该站点没有现成 playbook，但 scout 看到了有价值的结构：
- 运行 `scaffold_playbook.py`
- 生成初始 playbook stub

这一步的目的不是立刻得到高置信复放，而是给后续复盘留锚点。

## 7.9 选路

动作：
- `select_execution_plan.py`

常见 route 包括：
- `replay_trajectory_playbook`
- `reuse_email_account`
- `direct_submit`
- `register_email_account`
- `magic_link_login`
- `page_understanding`
- `agent_live_takeover`
- `park_hard_antibot`
- `park_for_policy_decision`
- `park_for_missing_input`

## 7.10 生成执行简报

动作：
- `prepare_worker_brief.py`

目的：
- 给执行层一个小而准的 brief
- 不让 browser worker 重读全量 profile、store、raw logs

## 7.11 浏览器执行

动作：
- 进入 `execution-core`
- 根据 scout / replay / takeover + browser control stack 执行

如果当前 route 还是低成本路径：
- 先做 lightweight scout
- 抽取 surface summary / field hints / anti-bot hints
- 尝试判断是否已有 playbook 可复放
- 判断 evidence sufficiency

## 7.12 Evidence Sufficiency 判断

如果当前证据已经足够支持一个确定下一步动作：
- 直接执行

如果不够：
- 生成 `task-xxxx-page-understanding.json`
- 先进入 Page Understanding

如果 Page Understanding 之后仍然无法确定提交流程：
- 升级到 `agent_live_takeover`
- 允许 Agent 在预算内直接查看并操作浏览器
- 要求把全过程记录成 trajectory artifact

触发场景通常有：
- entry CTA 有，但最终 submit 不明确
- form 在 iframe 里
- auth 路径混杂
- scout 与 browser 证据矛盾
- 低成本证据无法把站点缩小到一个可靠提交路径

## 7.13 Page Understanding + live takeover 回路

动作：
1. `prepare_page_understanding.py` 生成 artifact
2. Agent 读取 artifact，产出结构化 decision
3. `record_page_understanding.py` 记录决策
4. 如果 decision 已经足够，优先 replay 或走低成本执行
5. 如果 decision 仍不足，进入 `agent_live_takeover`
6. takeover 在预算内多步推进，直到：
   - 成功提交
   - 明确死路 / 终止条件
   - 进入某个等待态
   - 预算耗尽
7. 写入 `task-xxxx-live-takeover-trajectory.json` 和 `task-xxxx-takeover-summary.json`
8. 必要时 requeue，同 task 继续 `run_next.py`

重点是：
- Page Understanding 仍然只是“语义整理层”
- 真正的复杂提交由最终兜底层完成
- takeover 必须有预算、轨迹、停止条件和状态机落点

## 7.14 完成任务并沉淀记忆

动作：
- `finish_task()`
- 根据结果更新 task status
- 成功时更新 ledger
- 必要时更新 account registry
- takeover 成功时沉淀 trajectory playbook

这一步非常关键。

如果只“完成提交”但不写记忆，那么系统没有真正变强。

---

## 8. 任务状态机与恢复机制

## 8.1 状态定义

V2.1 使用的核心状态有：
- `READY`
- `RUNNING`
- `WAITING_EXTERNAL_EVENT`
- `WAITING_POLICY_DECISION`
- `WAITING_MISSING_INPUT`
- `WAITING_MANUAL_AUTH`
- `WAITING_SITE_RESPONSE`
- `RETRYABLE`
- `DONE`
- `SKIPPED`

## 8.2 设计含义

### `READY`
可以马上工作。

### `RUNNING`
当前已被某个 worker claim。

### `WAITING_EXTERNAL_EVENT`
流程已推进到邮箱验证、magic link 或其他外部回调阶段，等待 `gog` 或轮询信号自动恢复。

### `WAITING_POLICY_DECISION`
已经触达业务决策点，但无人值守模式不会停下来等人拍板；它是一个细分审计终态。

### `WAITING_MISSING_INPUT`
明确缺少必需文案、分类、素材或授权边界；它是一个细分审计终态。

### `WAITING_MANUAL_AUTH`
明确需要密码、2FA、设备确认或其他无人值守不支持的认证动作；它是一个细分审计终态。

### `WAITING_SITE_RESPONSE`
已经完成提交，等待站点审核或发布结果。

### `RETRYABLE`
不是终止失败，可以后续再试。

### `DONE`
成功完成提交/验证/已存在。

### `SKIPPED`
明确终止，不值得继续自动推进。

## 8.2.1 为什么还要强制 `wait_reason_code`

只把状态拆细还不够。

每个等待态还应至少带这些字段：
- `wait_reason_code`
- `resume_trigger`
- `resolution_owner`
- `resolution_mode`
- `evidence_ref`

原因是状态只回答“卡在哪”，但不回答：
- 为什么卡在这
- 是否会被自动恢复
- 由谁自动恢复，或是否只是审计终态
- 恢复时要看哪份证据

如果没有这四个字段，reporter 很难做聚合，watchdog 也很难做有界恢复。

## 8.3 为什么按“单行任务”推进

因为单个站点可能涉及：
- 注册
- 验证
- 回信
- 多步表单
- 审核等待

如果把整批任务揉成一个大流程，就无法恢复。

而按单行推进，系统天然获得：
- 断点恢复能力
- 并发安全性
- 精确统计
- watchdog 可观测性

## 8.4 锁与 stale recovery

每个 task 都有：
- `locked_by`
- `lock_expires_at`

如果 worker 异常退出，watchdog 或 claim 前置逻辑会：
- 识别 stale lock
- 释放锁
- 把 `RUNNING` 回收到 `RETRYABLE`

这使系统不会因为一次崩溃永久卡死。

---

## 9. 路由选择与执行策略

## 9.1 选路优先级

默认顺序是：

1. 精确 trajectory playbook 复放
2. 复用已有 site account
3. 无登录直接提交
4. 邮箱注册
5. Page Understanding
6. agent live takeover
7. park

这个顺序反映了系统的成本偏好：
- 先复用现成资产
- 再走最轻量路径
- 最后才走更重、更贵的接管路径

## 9.2 为什么优先 email signup，而不是 OAuth

因为邮箱注册通常更：
- 可控
- 可追踪
- 可复用
- 易沉淀成 account memory

在 V2.1 中，它还有额外价值：
- 可以通过 `gog` 自动读取验证邮件
- 不必把邮箱验证视为人工阻塞
- 更容易自动恢复到同一个 task

OAuth 可用，但要在策略允许下，并且 scope 正常。

## 9.3 对 anti-bot 的处理原则

### 软验证码
如 simple text / math / obvious image：
- 允许谨慎尝试一次

### 硬风控
如：
- Cloudflare
- Turnstile
- reCAPTCHA
- hCaptcha
- managed challenge

原则：
- 不绕过
- 浏览器确认后 skip 或 park
- 不死循环重试

## 9.4 对 reciprocal backlink 的处理原则

不自动接受。

原因很简单：
- 这已经不是“填写表单”问题，而是业务决策问题
- 是否接受互链，影响品牌、SEO 和页面策略

因此统一 park 到 `WAITING_POLICY_DECISION`。

## 9.5 对 paid listing 的处理原则

系统可以识别付费面，但不自动付款。

会做的事：
- 识别 paid gate / sponsor surface
- 记录证据
- 产出明确的审计终态和可复用的站点结论

不会做的事：
- 自动充值
- 自动购买 listing

在状态机里，这类情况应进入 `WAITING_POLICY_DECISION`，而不是泛化为“人工等待”。

---

## 10. 浏览器执行架构

## 10.1 单脑浏览器架构（Single-Brain Browser Architecture）

V2 的核心选择是：

> 路由决策在一个脑子里完成，浏览器动作尽量在同一个共享浏览器上下文里执行。

实际落地是：
- `browser-use` CLI 负责探索与轻交互
- Playwright 负责确定性动作与断言
- 两者尽量共用同一 shared CDP browser

## 10.2 为什么不是“全都交给 Playwright”

纯 Playwright 对固定流程很强，但对未知页面探索成本高。

## 10.3 为什么不是“默认全都交给自由 Agent”

V2.1 允许 Agent live takeover，但不把它设成默认主路径。

原因是：
- token 和时间成本高
- 长时间接管更容易失控
- 如果没有轨迹沉淀，下次还是从零开始
- watchdog 和 reporter 需要明确的预算边界

所以 V2.1 的原则是：
- 默认先走低成本证据
- Page Understanding 先做案卷整理
- 只有仍不够时才触发 bounded takeover

## 10.4 Provider 抽象

Browser control 层解决“怎么执行”的问题。

常见执行工具：
- `Playwright`
- `browser-use-cli` fallback
- `dry-run`

这样做的意义是：
- planner 不依赖具体浏览器实现
- 可以根据环境在 preflight 阶段切换执行器或 fallback 工具
- fallback 工具故障不会逼迫 planner 重写

## 10.5 Scout 抽象

V2.1 弱化了 Adapter，把它降级成 lightweight scout。

它解决的是：

> “在不花高 token 成本的前提下，先把页面大概摸清。”

它负责：
- 收集交互控件
- 识别 field_map
- 区分 submit control / entry CTA / signup / login
- 识别 iframe surface
- 判断是否存在 paid gate / challenge / auth surface
- 计算 evidence sufficiency
- 决定是否推荐 page understanding 或 live takeover

它不再承担复杂站点的主提交职责。

---

## 11. Page Understanding 升级机制

这是 V2 最重要的架构亮点之一。

## 11.1 核心原则

不是问：
- “有没有命中某个已知异常类？”

而是问：
- “现在的证据，够不够支持一个确定的下一步动作？”

如果不够，就先升级到 Page Understanding；再不够，就升级到 live takeover。

## 11.2 为什么这很重要

现实世界页面非常脏，问题不只是：
- 验证码
- 登录
- Cloudflare

更多的是“模糊性”：
- 页面有多个 CTA
- 真表单藏在 iframe 里
- 首页上看着像 submit，实际只是 newsletter form
- submit / promote / sponsor / launch 混在一起
- browser 看到的与 HTTP scout 不一致

如果系统靠“异常类别白名单”驱动升级，很快就会漏。

而 evidence sufficiency 是更本质的规则。

## 11.3 Artifact 结构

Page understanding artifact 一般会包含：
- task 摘要
- policy
- promoted-site 摘要
- plan 摘要
- execution summary
- page evidence
  - field_map
  - page_state
  - control summary
  - surface summary
  - iframe summary
  - evidence sufficiency
- agent job 说明
- orchestration commands

这使得 agent 不必去翻全量日志，而是拿到一个小而够用的“接管前案卷”。

## 11.4 Agent 输出格式

要求 agent 输出结构化 decision，例如：
- `page_kind`
- `recommended_path`
- `candidate_actions`
- `terminal_reason`
- `evidence`

重点是 `candidate_actions` 最好能被 deterministic executor 消费，比如：
- click 某个可见文本
- fill 某个 label
- press 某个 key
- 指定 iframe hint

如果仍然无法收敛成确定动作，就应该显式建议升级到 `agent_live_takeover`。

## 11.5 为什么 V2.1 允许 bounded takeover，但不允许无界接管

如果允许无界接管：
- 动作不可重放
- token 不可控
- 结果不可审计
- 任务状态机会被会话状态吞掉
- batch / watchdog 很难协作

所以 V2.1 的定位是：

> **Page Understanding 不是浏览器驾驶层；agent live takeover 才是最终兜底驾驶层，但它必须有预算、轨迹和回收机制。**

---

## 12. 无人值守运行：batch、reporter、watchdog

## 12.1 为什么 worker 不能无限循环

如果一个 agent turn 无限跑：
- 容易上下文膨胀
- 容易卡死
- 容易丢失中间状态
- 不利于 cron 调度与恢复

所以 V2 采用小批次模式：
- `run_batch.py`
- 每次处理少量任务
- 拿 run 级 single-flight lock
- 处理完退出
- 等下一次 cron tick 再继续

## 12.2 Reporter 为什么必须独立

进度汇报和 worker 不是一回事。

如果把汇报逻辑塞进 worker：
- worker 一超时，汇报也没了
- 汇报无法独立判断“有没有卡死”
- 容易污染执行逻辑

所以 reporter 的原则是：
- 只读
- 不 claim task
- 不改状态
- 只生成中文摘要和 markdown 报表
- 能区分 `WAITING_EXTERNAL_EVENT` / `WAITING_POLICY_DECISION` / `WAITING_MISSING_INPUT` / `WAITING_MANUAL_AUTH` / `WAITING_SITE_RESPONSE`
- 能统计 takeover 成功率、超时率和 playbook replay 成功率

## 12.3 Watchdog 为什么必须独立

watchdog 不是 worker，也不是 reporter。

它只做三件事：
1. 发现 worker 卡住
2. 发现 reporter 失联
3. 做一次有界恢复并报警

它不会：
- 无限重跑 worker
- 无限重跑 reporter
- 一直刷健康日志

## 12.4 Watchdog 的恢复策略

允许做的恢复包括：
- 释放 stale task locks
- 在无 batch lock 且 backlog 还在时，补跑一次 worker
- reporter 太久没更新时，补跑一次 reporter
- 对超时的 `WAITING_EXTERNAL_EVENT` 做一次恢复判断，并转成 `RETRYABLE` 或细分审计终态

如果恢复失败：
- 报警给人
- 不继续死循环

## 12.5 这套设计的本质价值

它把“自动化能跑”提升成了“自动化能长期稳定地跑”。

这两者差别很大。

---

## 13. 安全边界与业务边界

## 13.1 不绕过高级风控

这是系统级原则。

确认硬风控后：
- skip / park
- 不做破解
- 不做连续重试

## 13.2 不自动做商业决策

比如：
- 付费 listing
- reciprocal backlink
- 披露 founder/phone/address

这些都属于业务边界，不属于“自动化应该擅自决定”的范围。

## 13.3 不编造产品信息

系统所有提交文本都应来自 promoted-site profile。

如果 profile 缺字段：
- 补 intake
- 补 probe
- 不允许胡写

## 13.4 不泄露 secrets

- 密码不写进 playbook
- 密码不写进 account registry
- 日志和 artifact 只留引用

## 13.5 不重复提交

ledger 是硬约束。

只要判定“同 promoted site + 同 target”已有活跃记录，就不应再重新提交。

---

## 14. 为什么 V2 比“普通自动化”更强

## 14.1 它不是一次性脚本，而是记忆系统

普通自动化：
- 今天提交完就结束
- 成功经验留在日志里

V2：
- 成功会被提升成 playbook
- 下次从 reuse 开始

## 14.2 它不是单浏览器流程，而是任务状态机

普通自动化：
- 中途挂了就很难恢复

V2：
- 每行独立 claim/checkpoint/finish
- 可以恢复单行，不影响整批

## 14.3 它不是“要么全自动，要么全手动”

V2.1 是分层自动化：
- 简单的自动跑
- 模糊的先做案卷整理
- 实在不行再做 bounded takeover
- 遇到不同阻塞进入不同等待态

这比二元模式更贴近真实业务。

## 14.4 它不是盲目 LLM 驱动，而是结构化混合架构

- LLM 负责理解
- Provider 负责浏览器执行
- live takeover 负责最终兜底
- Task store 负责记忆任务状态
- trajectory playbook 负责复用成功路径
- Watchdog 负责兜底

这是工程化，不是 demo 化。

## 14.5 它有“证据充足性”这个本质规则

很多系统失败，是因为升级逻辑靠 if/else 枚举异常。

V2 用更本质的问题来决定升级：

> 当前证据，是否足以支持一个确定动作？

这是更可扩展的架构原则。

---

## 15. 如果合作伙伴要复刻，建议怎么落地

如果对方也想实现一套，建议不要一开始就追求 100% 完整复制，而是按层推进。

## 15.1 先拆成五个模块

### 模块 A：任务与状态层
先做：
- run manifest
- task store
- claim/checkpoint/finish
- submission ledger

这是最底层骨架。

### 模块 B：资料与记忆层
再做：
- promoted-site profile
- site playbook
- account registry

没有这层，系统不会越跑越强。

### 模块 C：执行层
再做：
- browser control abstraction
- lightweight scout
- live takeover loop
- trajectory replay
- 一个共享浏览器上下文

先不必做很多 site-specific adapter，甚至可以先不做。

### 模块 D：升级推理层
然后做：
- page-understanding artifact
- decision schema
- takeover budget / stop rules
- trajectory capture

这是从“自动化脚本”进化到“智能系统”的关键。

### 模块 E：运维层
最后补：
- batch lock
- reporter
- watchdog
- bounded recovery

这是从“能跑”进化到“可托管”的关键。

## 15.2 最小 MVP 可以长这样

如果合作伙伴要先做一个 MVP，我建议最少包含：
- task store
- submission ledger
- promoted-site profile
- scout + select execution plan
- Page Understanding artifact
- agent live takeover
- trajectory playbook
- `READY/RUNNING/WAITING_EXTERNAL_EVENT/WAITING_POLICY_DECISION/WAITING_MISSING_INPUT/WAITING_MANUAL_AUTH/WAITING_SITE_RESPONSE/RETRYABLE/DONE/SKIPPED`

先别急着做：
- 复杂 OAuth
- 深度 watchdog
- 太多站点专用 adapter
- 太花的汇报系统

先把“单行可恢复 + takeover 有预算 + 等待态可操作 + 不重复提交 + 有长期记忆”做出来，系统就已经和普通脚本不是一个级别了。

## 15.3 如果要做成平台级产品

建议再往上抽象三层：

### 1. Policy Layer
把这些东西做成可配置策略：
- allow_oauth_login
- allow_paid_listing
- allow_reciprocal_backlink
- allow_manual_captcha
- disclosure boundaries

### 2. Skill / Adapter Marketplace
把 trajectory playbook、site-specific scout、接管提示模板变成可插拔模块。

### 3. Observation + Replay Scoring
为 playbook 建立 replay score / stability score，自动决定：
- 直接复放
- 带观察复放
- 强制重新 scout

## 15.4 技术栈上哪些可替换，哪些最好别换

### 可替换
- LLM 供应商
- 具体 browser control tool
- 具体存储格式（JSON / SQLite / Postgres）
- 具体 cron 系统

### 最好别丢
- 单任务状态机
- 四层记忆结构
- bounded takeover
- evidence sufficiency 升级规则
- 独立 reporter/watchdog

这几项是架构本体，不建议砍。

---

## 16. 总结

Web Backlinker V2 的核心，不在于“会不会自动点网页”。

真正的核心是四句话：

1. **把一次提交变成可复用记忆。**
2. **把一个站点建模成一个可恢复任务。**
3. **把页面理解和浏览器执行分离。**
4. **把无人值守运行做成可观测、可恢复的系统。**

所以它本质上是一个：

> **面向目录站/外链提交流程的、状态驱动的、带长期记忆的执行系统。**

如果你的合作伙伴也想做一套，最值得学的不是某个具体脚本，而是这几个架构原则：
- Memory-first
- Task-first
- Deterministic execution
- Evidence-sufficiency escalation
- Bounded recovery

这几条抓住了，换浏览器、换模型、换存储，系统都还能成立。
