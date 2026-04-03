# Web Backlinker V2.1 架构图版说明

> 当前 repo 的运行方式、状态契约、站点案例和维护入口，请先看 [README.md](README.md) 与 [docs/](docs/) 下文档。
> 这份文件继续保留为 `north star` 图版说明，不等价于当前代码实现细节。
> 当前 repo 的默认实现已经是 unattended-first：新站默认 `scout -> agent-driven browser-use CLI -> Playwright evidence finalization`，`WAITING_POLICY_DECISION / WAITING_MANUAL_AUTH / WAITING_MISSING_INPUT` 仅作为审计终态使用。

> 用途：给技术合伙人、架构师、工程负责人快速看懂 Web Backlinker V2.1。
>
> 建议搭配阅读：
> - `references/technical-architecture-zh.md`：完整文字版
> - `references/architecture.md`：英文概览版
>
> 阅读顺序建议：
> 1. 先看“系统全景图”
> 2. 再看“主执行时序图”
> 3. 再看“Page Understanding 升级回路”
> 4. 最后看“状态机”和“无人值守运维图”

---

## 1. 系统全景图

这个图回答一个问题：**整套系统由哪些层组成，它们之间怎么协作。**

```mermaid
flowchart TB
    U[操作者 / User\n提供 promoted URL、目标列表、策略边界] --> C[Control Plane\nbootstrap_runtime / init_intake / run_next / run_batch / select_execution_plan]

    C --> M[Memory Plane\npromoted-site profile\nsite playbook\naccount registry\nsubmission ledger]
    C --> E[Execution Plane\nlightweight scout + browser tools\nlive takeover + replay]
    C --> O[Ops Plane\nreporter / watchdog / cron]

    M --> A[Artifacts & Runtime State\nmanifest\ntask store\nbrief\nplan\nexecution result\npage-understanding artifact]
    E --> A
    O --> A

    A --> C
```

### 图解

- **Control Plane** 是大脑，负责编排，不直接负责浏览器细节。
- **Memory Plane** 负责“下次更便宜”，把一次成功沉淀为长期资产。
- **Execution Plane** 负责轻量侦察、轨迹复放、以及最终兜底层浏览器接管。
- **Ops Plane** 负责无人值守运行时的汇报、监控和恢复。
- **Artifacts & Runtime State** 是这套系统的“外部记忆”和“运行真相源”。

---

## 2. 控制面 + 记忆面 + 执行面的详细模块图

这个图更细地展示主要脚本和核心模块。

```mermaid
flowchart LR
    subgraph ControlPlane[Control Plane]
        BR[bootstrap_runtime.py]
        PI[probe_promoted_site.py]
        II[init_intake.py]
        TS[task_store.py]
        SEP[select_execution_plan.py]
        RN[run_next.py]
        RB[run_batch.py]
    end

    subgraph MemoryPlane[Memory Plane]
        PF[promoted-site profile]
        PB[site playbooks]
        AR[account registry]
        SL[submission ledger]
    end

    subgraph ExecutionPlane[Execution Plane]
        CLI[execution-core cli.js]
        SC[Lightweight Scout\nsurface + field hints]
        RP[Trajectory Replay]
        LT[Agent Live Takeover]
        PR[Browser Control Tools\nPlaywright executor\nbrowser-use-cli fallback\ndry-run]
    end

    subgraph ReasoningUpgrade[Reasoning Upgrade Layer]
        PPU[prepare_page_understanding.py]
        AG[Agent semantic reasoning]
        RPU[record_page_understanding.py]
        TR[trajectory recorder]
    end

    BR --> PI --> II --> TS
    TS --> RN
    RN --> SEP
    SEP --> CLI
    CLI --> SC --> PR
    CLI --> RP --> PR

    RN --> PF
    RN --> PB
    RN --> AR
    RN --> SL

    SC -->|evidence insufficient| PPU --> AG --> RPU --> LT --> PR
    LT --> TR --> RN
```

### 图解

- `run_next.py` 是主协调器。
- `task_store.py` 是任务状态机核心。
- `select_execution_plan.py` 是路线选择器。
- `execution-core` 是浏览器执行层。
- 当低成本证据不足时，先进入 **Reasoning Upgrade Layer**，再按需要升级到 **Agent Live Takeover**。

---

## 3. 四层记忆结构图

这个图回答：**系统到底记什么，为什么后续运行会越来越便宜。**

```mermaid
flowchart TD
    subgraph MemoryLayers[四层记忆结构]
        P1[1. Promoted-site Profile\n产品事实来源\n名称 / URL / 描述 / 分类 / 邮箱 / 披露边界]
        P2[2. Site Playbook\n目标站点提交记忆\n入口 / 字段映射 / 步骤 / 成功信号 / 复放置信度]
        P3[3. Account Registry\n站点账号复用记忆\n邮箱 / auth type / mailbox / browser profile ref]
        P4[4. Submission Ledger\n防重复提交\npromoted URL + target domain + state]
    end

    P1 --> X[后续提交内容真实且统一]
    P2 --> Y[同站点下次直接复放]
    P3 --> Z[避免重复注册账号]
    P4 --> W[避免重复提交同一目标站点]
```

### 图解

- **Profile** 解决“写什么”。
- **Playbook** 解决“怎么做”。
- **Account Registry** 解决“用哪个账号做”。
- **Ledger** 解决“还要不要做”。

---

## 4. 运行目录与数据落盘图

这个图回答：**这些状态和资产实际存在哪。**

```mermaid
flowchart TB
    ROOT[data/backlink-helper/] --> ACC[accounts/]
    ROOT --> ART[artifacts/]
    ROOT --> PB1[playbooks/sites/]
    ROOT --> PB2[playbooks/patterns/]
    ROOT --> PRO[profiles/]
    ROOT --> RUN[runs/]
    ROOT --> TASK[tasks/]
    ROOT --> REP[reports/]
    ROOT --> LED[submission-ledger.json]

    RUN --> MAN[manifest: run config + preflight + reporting + watchdog]
    TASK --> STORE[task store: per-target task state]
    ART --> SCOUT[scout / brief / plan / execution / page-understanding / takeover artifacts]
    PRO --> PROFILE[promoted-site profile + intake]
    REP --> REPORTER[progress snapshots + final report + watchdog state]
```

### 图解

这套系统不是把状态藏在会话里，而是**显式落盘**。这样才有：
- 断点恢复能力
- 多轮运行复用能力
- watchdog 可观测性
- 事后审计能力

---

## 5. 主执行流程图（业务主线）

这个图回答：**一轮 campaign 从启动到持续推进，主流程是怎样的。**

```mermaid
flowchart TD
    A[创建 run\nbootstrap_runtime.py] --> B[探测 promoted site\nprobe_promoted_site.py]
    B --> C[收集 intake\ninit_intake.py]
    C --> D{required intake\n是否完整?}
    D -- 否 --> E[终止真实提交\n补齐 intake 后再创建 run]
    D -- 是 --> F[导入 targets\ntask_store.py init]
    F --> G[运行 preflight\n确认 browser stack / gog]
    G --> H[启动 worker batch\nrun_batch.py]
    H --> I[claim 单个 task\nrun_next.py]
    I --> J[scout target]
    J --> K[select execution plan]
    K --> L[生成 worker brief]
    L --> M[execution-core submit]
    M --> N{证据是否足够支持\n确定下一步动作?}
    N -- 是 --> O[直接执行 / finish task]
    N -- 否 --> P[生成 page-understanding artifact]
    P --> Q[Agent 输出结构化决策]
    Q --> R{仍无法确定提交路径?}
    R -- 否 --> S[低成本执行 / replay]
    R -- 是 --> T[进入 agent live takeover]
    T --> U{提交成功 / 明确等待 / 终止?}
    U -- 是 --> V[finish task]
    U -- 否 --> W[budget 用尽 -> 等待态或 RETRYABLE]
    S --> M
    V --> X[更新 playbook / account / ledger]
    W --> X
    X --> Y[claim 下一条 task]
    Y --> I
```

### 图解

这条主线有两个非常关键的设计点：

1. **不是一次跑完整批，而是按单 task 推进。**
2. **不是一开始就让 Agent 接管，而是先用便宜证据和 artifact，最后才升级到 bounded takeover。**

---

## 6. 单任务执行时序图

这个图回答：**一个 task 从 claim 到 finish 的时序是怎样的。**

```mermaid
sequenceDiagram
    participant Worker as run_next.py
    participant Store as task_store.py
    participant Scout as scout_target.py
    participant Planner as select_execution_plan.py
    participant Brief as prepare_worker_brief.py
    participant Exec as execution-core
    participant Memory as Playbook/Account/Ledger

    Worker->>Store: claim task
    Store-->>Worker: task status=RUNNING

    Worker->>Scout: scout target url
    Scout-->>Worker: site_type/auth/anti_bot/submit surface

    Worker->>Store: checkpoint scout result
    Worker->>Memory: read playbook/account/ledger
    Worker->>Planner: choose plan
    Planner-->>Worker: route + execution_mode + disposition

    Worker->>Brief: build compact worker brief
    Brief-->>Worker: brief.json

    Worker->>Exec: submit(task, brief, plan)
    Exec-->>Worker: scout/replay outcome + notes + compile_hint

    alt evidence sufficient
        Worker->>Store: finish task
        Worker->>Memory: update ledger / playbook / account
    else evidence insufficient
        Worker->>Worker: prepare page-understanding artifact
        Worker->>Exec: agent live takeover
        Exec-->>Worker: takeover summary + trajectory
        Worker->>Store: finish as WAITING_* / RETRYABLE / DONE / SKIPPED
        Worker->>Memory: update trajectory playbook / account / ledger
    end
```

### 图解

主执行链条不是“浏览器脚本”，而是：

> **状态机 + 侦察 + 规划 + bounded takeover + 记忆更新**

---

## 7. 路由选择决策图

这个图回答：**系统如何决定下一步该走哪条路。**

```mermaid
flowchart TD
    A[读取 task + playbook + account + intake policy] --> B{已有高置信 playbook?}
    B -- 是 --> B1[route = replay_site_playbook]
    B -- 否 --> C{已有可复用账号?}
    C -- 是 --> C1[route = reuse_email_account]
    C -- 否 --> D{无登录可直接提交?}
    D -- 是 --> D1[route = direct_submit]
    D -- 否 --> E{支持 email signup?}
    E -- 是 --> E1[route = register_email_account]
    E -- 否 --> F{支持 magic link?}
    F -- 是 --> F1[route = magic_link_login]
    F -- 否 --> G{Page Understanding 后\n仍不明确?}
    G -- 是 --> G1[route = agent_live_takeover]
    G -- 否 --> H{硬风控 / reciprocal backlink / paid gate / 内容型路径?}
    H -- 是 --> H1[park / skip / wait policy or input]
    H -- 否 --> I[继续侦察 / page_understanding / inspect_submit_surface]
```

### 图解

这个图背后的原则是：
- **先复用，再探索**
- **先轻路径，再重路径**
- **业务决策和安全风险不自动拍板**

---

## 8. 浏览器执行架构图

这个图回答：**为什么系统要把 scout、browser control、takeover、replay 分层。**

```mermaid
flowchart LR
    P[Planner / run_next] --> CLI[execution-core cli.js]
    CLI --> SC[Scout Layer\nsurface summary\nfield hints\nevidence hints]
    CLI --> RP[Replay Layer\ntrajectory playbook]
    CLI --> LT[Takeover Layer\nagent live takeover]
    SC --> PR[Browser Control Layer\nPlaywright executor\nbrowser-use-cli fallback\ndry-run]
    RP --> PR
    LT --> PR

    SC --> H[compile_hint\nfield_map / surface_summary / evidence_sufficiency]
    H --> P
```

### 图解

- **Scout** 关注页面/站点的低成本侦察。
- **Provider** 关注浏览器执行方式。
- **Replay** 关注成功轨迹复放。
- **Takeover** 关注最终兜底层浏览器接管。
- `compile_hint` 把执行层观察到的证据反馈回控制面。

这使系统具备“可升级”和“可替换”能力。

---

## 9. Evidence Sufficiency 升级决策图

这个图回答：**什么时候升级到 Agent 看 live page。**

```mermaid
flowchart TD
    A[当前已有 scout + DOM + compile_hint + surface summary] --> B{是否知道确切下一步动作?}
    B -- 否 --> UPGRADE[升级到 Page Understanding]
    B -- 是 --> C{是否知道动作在哪里?\nmain doc 还是 iframe?}
    C -- 否 --> UPGRADE
    C -- 是 --> D{是否知道动作后应该出现什么状态?}
    D -- 否 --> UPGRADE
    D -- 是 --> EXEC[直接执行或 replay]
    UPGRADE --> E{artifact 后仍不明确?}
    E -- 是 --> TAKEOVER[升级到 Agent Live Takeover]
    E -- 否 --> EXEC
```

### 图解

这张图是 V2 最重要的抽象之一。

系统不是靠异常白名单来决定升级，而是靠这三个问题：
1. 下一步动作是否明确？
2. 动作位置是否明确？
3. 动作后的预期状态是否明确？

只要有一个不明确，就升级；artifact 之后还不明确，就进入 live takeover。

---

## 10. Page Understanding 升级回路图

这个图回答：**复杂页面时，Agent 是怎么先做语义整理，再在最终兜底层接管浏览器的。**

```mermaid
sequenceDiagram
    participant Exec as execution-core / lightweight scout
    participant Prep as prepare_page_understanding.py
    participant Agent as Agent semantic reasoning
    participant Record as record_page_understanding.py
    participant Takeover as live_takeover_loop.py
    participant Worker as run_next.py

    Exec-->>Prep: compile_hint says evidence insufficient
    Prep-->>Agent: task + brief + plan + execution + page evidence artifact
    Agent-->>Record: structured decision JSON
    Record-->>Takeover: validated decision + takeover budget + route update
    Takeover->>Takeover: bounded browser actions
    Takeover-->>Worker: takeover summary + trajectory + next status
```

### 图解

这里最关键的是：
- Agent 先输出**结构化决策**，而不是直接乱跑
- takeover 只在预算内接管
- 执行完后必须回到主状态机并留下轨迹

这样既提高完成率，又不失去工程上的可控性。

---

## 11. Lightweight Scout 页面理解图

这个图回答：**轻量侦察层大致是怎么理解页面的。**

```mermaid
flowchart TD
    A[读取当前页面和 frame surfaces] --> B[收集交互控件 controls]
    B --> C[识别 field_map\nproduct_name / url / email / description / submit]
    C --> D[识别页面特征\nsubmit / entry CTA / signup / login / iframe / paid / challenge]
    D --> E[计算 evidence_sufficiency]
    E --> F{足够吗?}
    F -- 是 --> G[执行低成本动作或 replay]
    F -- 否 --> H[输出 page_understanding_recommended]
    H --> I{artifact 后仍不足?}
    I -- 是 --> J[升级到 agent_live_takeover]
```

### 图解

轻量侦察层并不是“瞎猜字段然后点提交”。

它做的是一个轻量版页面建模：
- 识别字段
- 识别按钮
- 区分 entry CTA 和 final submit
- 区分 registration surface 和 login surface
- 识别 iframe 嵌入表单
- 判断当前证据是否足够

---

## 12. 任务状态机图

这个图回答：**一个 task 在生命周期里有哪些状态，如何流转。**

```mermaid
stateDiagram-v2
    [*] --> READY
    READY --> RUNNING: claim
    RETRYABLE --> RUNNING: claim again
    WAITING_EXTERNAL_EVENT --> RUNNING: gog / poll event resumes
    WAITING_EXTERNAL_EVENT --> RETRYABLE: timeout / transient issue
    WAITING_SITE_RESPONSE --> DONE: site confirms listing / review completes

    RUNNING --> DONE: submitted / verified / already_listed
    RUNNING --> WAITING_EXTERNAL_EVENT: pending email / callback
    RUNNING --> WAITING_POLICY_DECISION: paid / reciprocal / disclosure
    RUNNING --> WAITING_MISSING_INPUT: missing content / asset
    RUNNING --> WAITING_MANUAL_AUTH: login / 2FA / consent required
    RUNNING --> WAITING_SITE_RESPONSE: submitted and pending review
    RUNNING --> RETRYABLE: defer_retry / transient failure
    RUNNING --> SKIPPED: dead route / hard anti-bot / terminal skip

    RUNNING --> RETRYABLE: stale lock released
```

### 图解

状态机设计的核心不是“优雅”，而是“可恢复”：
- 每个状态都有明确语义
- 自动等待、业务决策、缺输入、人工认证、站点审核各自独立
- stale RUNNING 能被回收
- 单 task 的失败不拖垮整 run

---

## 13. Run 级 batch worker 图

这个图回答：**为什么系统用小批次串行 worker，而不是一个长会话无限跑。**

```mermaid
flowchart TD
    A[cron tick] --> B[run_batch.py 获取 run-level batch lock]
    B --> C{拿到锁?}
    C -- 否 --> X[退出，避免并发冲突]
    C -- 是 --> D[串行跑 run_next 处理少量 task]
    D --> E{batch 限额到达?\nmax-tasks / max-seconds}
    E -- 否 --> D
    E -- 是 --> F[释放 batch lock 并退出]
    F --> G[等待下一次 cron tick]
```

### 图解

这套 batch 设计解决三个问题：
- 防止同一 run 被重叠 worker 并发污染
- 防止单次 turn 无限膨胀
- 让 watchdog 更容易判断“到底是真在跑，还是卡死了”

---

## 14. Reporter + Watchdog 无人值守运维图

这个图回答：**为什么 worker、reporter、watchdog 必须拆开。**

```mermaid
flowchart LR
    subgraph WorkerPath[执行链]
        W1[worker cron] --> W2[run_batch.py]
        W2 --> W3[task progress]
    end

    subgraph ReportingPath[汇报链]
        R1[reporter cron] --> R2[report_progress.py]
        R2 --> R3[中文摘要 + markdown 快照 / final report\n+ waits / takeover metrics]
    end

    subgraph WatchdogPath[健康检查链]
        D1[watchdog cron] --> D2[watchdog_status.py]
        D2 --> D3{是否异常?}
        D3 -- 否 --> D4[静默]
        D3 -- 是 --> D5[一次有界恢复\nrelease stale lock / rerun worker / rerun reporter]
        D5 --> D6[必要时告警]
    end

    W3 --> D2
    R3 --> D2
```

### 图解

拆开的好处：
- worker 只负责干活
- reporter 只负责汇报
- watchdog 只负责查健康和补救

如果把三者塞成一个 job，系统会非常脆弱。

---

## 15. Watchdog 决策图

这个图回答：**watchdog 实际上怎么判断要不要干预。**

```mermaid
flowchart TD
    A[watchdog_status.py 读取本地状态] --> B{存在 stale RUNNING task?}
    B -- 是 --> B1[release_stale_tasks]
    B -- 否 --> C{worker 超过阈值无进展?}
    C -- 是 --> C1{还有 runnable backlog 且无 active batch lock?}
    C1 -- 是 --> C2[run_worker_once]
    C1 -- 否 --> C3[告警，不强推]
    C -- 否 --> D{WAITING_EXTERNAL_EVENT 超时?}
    D -- 是 --> D1[转 RETRYABLE 或细分审计终态]
    D -- 否 --> E{reporter 超时 / final report 缺失?}
    E -- 是 --> E1[run_reporter_once]
    E -- 否 --> F[healthy / completed]
```

### 图解

watchdog 的关键词只有两个：
- **bounded**
- **silent when healthy**

它不是来刷存在感的，而是来避免静默停摆的。

---

## 16. 为什么这套图体现的是“系统”而不是“脚本”

如果把上面的图连起来看，会发现 Web Backlinker V2.1 的本质不是某个 submit 自动化脚本，而是一个完整执行系统：

```mermaid
flowchart TB
    A[Profile: 确保写出去的内容真实] --> B[Task Store: 把每个站点变成可恢复任务]
    B --> C[Planner: 根据记忆和策略选路]
    C --> D[Scout / Replay: 先走低成本路径]
    D --> E[Evidence Sufficiency: 证据不足时升级]
    E --> F[Page Understanding: 语义整理复杂页面]
    F --> G[Agent Live Takeover: 最终兜底层]
    G --> H[Memory Update: 沉淀 trajectory playbook / account / ledger]
    H --> I[Reporter + Watchdog: 支持长期无人值守]
```

### 一句话总结

> Web Backlinker V2.1 的关键不是“自动填写表单”，而是：
> **把目录站提交这件事，做成一个有记忆、有状态机、有升级机制、有轨迹复用、有运维闭环的工程系统。**

---

## 17. 给合作伙伴的 30 秒版本

如果你要把这个架构快速讲给别人听，可以直接用下面这段：

> 我们这套 Web Backlinker V2.1，不是普通 browser automation。它把每个目标站点当成一个可恢复任务来跑，用 task store 管状态，用 promoted-site profile、trajectory playbook、account registry、submission ledger 四层记忆做长期复用。默认先用便宜证据和 Page Understanding 缩小搜索空间，只有当这些仍不足以支持提交时，才升级到有预算、有轨迹的 Agent live takeover。再加上细分等待态、独立 reporter 和 watchdog，所以它不是一次性脚本，而是一套可长期无人值守、但仍可控可恢复、并且完成率优先的外链提交流水线。
