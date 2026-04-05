# Runtime Topology

用这份文档理解系统怎么分层、主链路怎么流动。

## Four Planes

- `Control Plane`
  负责编排 run、claim task、选路、决定是否升级到 Page Understanding 或 live takeover。
- `Memory Plane`
  负责四层记忆：profile、playbook、account registry、submission ledger。
- `Execution Plane`
  负责 lightweight scout、Playwright 执行、browser-use CLI fallback、live browser takeover、trajectory replay 和浏览器动作。
- `Ops Plane`
  负责 reporter、watchdog、batch lock、bounded recovery。

## Primary Flow

1. 初始化 run 和 manifest。
2. 构建 promoted-site profile，补齐 intake 和 policy。
3. 导入 targets，写入 task store，并结合 ledger 去重。
4. claim 一个 task。
5. scout target，读取既有记忆。
6. select execution plan。
7. 调 execution-core 执行 scout 或 replay。
8. 如果证据不足，先升级到 Page Understanding，再按需要升级到 live takeover。
9. finish task，更新记忆和 trajectory playbook。
10. reporter 汇报进度，watchdog 做健康检查、takeover 回收和有界恢复。

## Module Ownership

- `run_next` 是单任务主协调器。
- `task_store` 是任务真相源。
- `select_execution_plan` 是路线选择器。
- `execution-core` 是浏览器执行层，内部包含 lightweight scout、trajectory replay 和 live takeover。
- `prepare_page_understanding` + decision schema 组成语义升级层。
- `live takeover loop` 是最终兜底驾驶层。
- `report_progress` 是只读汇报器。
- `watchdog_status` 是本地健康检查与恢复决策器。

## Design Rule

讨论一个改动时，先明确它属于哪个 plane。不要在一个模块里混入多个 plane 的职责。
