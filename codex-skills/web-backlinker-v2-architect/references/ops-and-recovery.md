# Ops And Recovery

用这份文档处理 batch worker、reporter、watchdog 和 bounded recovery。

## Batch Worker

worker 不要无限循环。

应采用小批次运行：
- 获取 run-level batch lock
- 串行处理少量 task
- 达到 `max-tasks` 或 `max-seconds` 后退出
- 等待下一次 cron tick

这样更容易做：
- 并发控制
- 超时恢复
- 健康判断
- 上下文收敛

## Reporter

reporter 是只读组件。

职责：
- 汇总 task counts
- 识别最近变化
- 生成中文摘要和 markdown 报表
- backlog 清空时输出 final report
- 单独统计各等待态数量与 live takeover 成功率

禁止：
- claim task
- 修改 worker 状态
- 把汇报逻辑耦合进主执行链

## Watchdog

watchdog 不是 worker，也不是 reporter。

职责：
- 检查 stale RUNNING task
- 检查 worker 是否长期无进展
- 检查 reporter 是否滞后
- 检查 live takeover session 是否卡死
- 检查 `WAITING_EXTERNAL_EVENT` 是否超时未恢复
- 在安全前提下做一次有界恢复

允许的恢复动作：
- release stale locks
- 在无 batch lock 且 backlog 存在时补跑一次 worker
- reporter 缺失时补跑一次 reporter
- 对超时的 `WAITING_EXTERNAL_EVENT` 做一次恢复判断并分流到 `RETRYABLE` 或细分审计终态

禁止：
- 无限重跑
- 无限告警
- 在健康时频繁刷存在感

## Recovery Rule

始终优先：
- `bounded`
- `deterministic`
- `silent when healthy`

恢复失败时，升级告警给人，不要继续死循环。
