# Python Similarweb Backlinks Exporter

这个目录放的是浏览器扩展的 Python 版最小复刻。

它做的事情只有这些：

1. 通过 CDP 接管你已经打开并登录好的 Chrome
2. 找到 `sim.3ue.com` 的反链列表页
3. 新开一个工作页分页采集反链 URL
4. 可选地自动启动独立 Chrome profile 池访问 `https://data.similarweb.com/api/v1/data?domain=...`
5. 如果开启流量查询，失败会写入缓存并延迟重试，最终从成功缓存导出 CSV

## 安装

```bash
cd /Volumes/WD1T/outsea/backliner-helper/python-sim-backlinks
python3 -m pip install -r requirements.txt
```

## 启动 Chrome CDP

先手动启动一个你要复用登录态的 Chrome：

```bash
open -na "/Applications/Google Chrome.app" --args \
  --remote-debugging-port=9223 \
  '--remote-allow-origins=*' \
  --user-data-dir=/tmp/chrome-cdp \
  about:blank
```

然后在这个 Chrome 里登录 `sim.3ue.com`，并打开目标反链列表页。

## 运行

默认会自动探测本地常见 CDP 端口：`9222/9223/9224/9229`。

```bash
cd /Volumes/WD1T/outsea/backliner-helper/python-sim-backlinks
python3 main.py
```

也可以显式指定：

```bash
python3 main.py --cdp-url http://127.0.0.1:9223
python3 main.py --cdp-url http://127.0.0.1:9223 --output ./output/custom.csv
```

常用续跑和风控参数：

```bash
python3 main.py \
  --cdp-url http://127.0.0.1:9223 \
  --data-browser-count 2 \
  --data-browser-proxy http://127.0.0.1:7890 \
  --data-failure-threshold 3 \
  --max-traffic-attempts 8 \
  --retry-base-delay-seconds 60 \
  --retry-max-delay-seconds 600
```

如果你只想导出反链链接，不走后续 Similarweb 流量查询，可以直接加：

```bash
python3 main.py --cdp-url http://127.0.0.1:9223 --links-only
```

这个模式下：

- 只导出 `hostname` 和 `source_url`
- 不会启动数据浏览器池
- 不会访问 `data.similarweb.com`
- 不会进入流量重试队列

默认缓存路径按当前 `sim.3ue.com` 源页面 URL 自动生成：

```text
python-sim-backlinks/runtime/cache/<source-url-hash>.json
```

如果要指定缓存文件或忽略旧缓存：

```bash
python3 main.py --cache-path ./runtime/cache/custom.json
python3 main.py --fresh
```

缓存里会记录：

- 源页面 URL
- 已采集的反链 `hostname/source_url`
- 成功的流量结果
- 待重试队列
- 每个域名的 `attempts/status/last_error/next_retry_at`
- 当前 Clash 节点和数据浏览器索引

## 图形界面

如果不想记命令，可以打开 Python GUI：

```bash
python3 main.py --gui
```

GUI 里可以配置：

- CDP 浏览器地址，例如 `http://127.0.0.1:9223`
- 输出 CSV 路径
- Clash 外部控制地址，例如 `http://127.0.0.1:9097`
- Clash 密钥
- 自动切换节点时要排除的节点名关键词
- 数据浏览器实例数
- 数据浏览器代理，默认 `http://127.0.0.1:7890`
- 连续失败换浏览器阈值
- 单域名最大尝试次数
- 缓存文件路径
- 是否只导出反链链接并跳过流量查询
- 是否忽略旧缓存重新开始

## Clash 自动切换节点

命令行模式默认不切换 Clash。需要自动切换时，加 `--enable-clash`：

```bash
python3 main.py \
  --cdp-url http://127.0.0.1:9223 \
  --enable-clash \
  --clash-url http://127.0.0.1:9097 \
  --clash-secret 809001 \
  --clash-exclude-keywords "香港,HK,官网,剩余流量"
```

触发切换的时机：

- 访问 `https://data.similarweb.com/api/v1/data?...` 超时
- 浏览器没有拿到响应
- Similarweb 返回 HTTP `403/429/5xx` 等错误
- 页面返回的内容不是可解析的 Similarweb JSON 数据

切换规则：

1. 从 Clash `/proxies` 里找可选择的代理组，优先使用 `GLOBAL`、`Proxy`、`PROXY`、`节点选择` 等常见组名。
2. 排除 `DIRECT`、`REJECT`，以及包含你配置关键词的节点。
3. 选择当前节点后面的下一个可用节点。
4. 调用 `PUT /proxies/{group}` 后轮询 `GET /proxies/{group}`，直到 `now` 等于目标节点。
5. 确认后等待 3 秒稳定时间，再继续后续重试队列。

## 数据浏览器和延迟重试

`sim.3ue.com` 的反链页仍使用你手动登录的 CDP Chrome。Similarweb 数据请求使用脚本自动启动的独立 Chrome profile 池，默认 2 个实例：

```text
python-sim-backlinks/runtime/data-browsers/profile-1
python-sim-backlinks/runtime/data-browsers/profile-2
```

这些数据浏览器默认强制走本地代理：

```text
http://127.0.0.1:7890
```

如果 Clash Verge 的 mixed/http 端口不是 `7890`，用 `--data-browser-proxy` 改成实际端口。

失败处理规则：

- `403/429/5xx`、超时、无响应、非 JSON、域名不匹配都会进入延迟重试。
- 连续 3 次可重试失败后，切换到下一个数据浏览器实例。
- 单个域名最多尝试 8 次。
- 达到上限后标记为 `deferred_failed`，不会当作“无数据”静默丢弃。
- 默认退避为 `60s, 120s, 240s...`，最长 600 秒。

## 输出

默认输出到：

```text
python-sim-backlinks/output/sim-backlinks-YYYYMMDD-HHMMSS.csv
```

CSV 列为：

```text
hostname,source_url,monthly_visits
```

只保留 `monthly_visits > 100` 的记录。

如果开启了 `--links-only` 或在 GUI 勾选了“Export backlinks only and skip Similarweb traffic lookup”，CSV 会改成：

```text
hostname,source_url
```

此时不会写入 `monthly_visits` 列，也不会过滤流量阈值。

## 已知边界

- 不做 WebSpy 回退
- 不直接用 `requests` 访问 Similarweb
- 自动启动的数据浏览器默认走 `http://127.0.0.1:7890`，需要确保 Clash Verge 对应端口已开启
- 如果 `sim.3ue.com` 页面结构变了，脚本会直接报错
