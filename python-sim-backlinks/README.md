# Python Similarweb Backlinks Exporter

这个目录放的是浏览器扩展的 Python 版最小复刻。

它做的事情只有这些：

1. 通过 CDP 接管你已经打开并登录好的 Chrome
2. 找到 `sim.3ue.com` 的反链列表页
3. 新开一个工作页分页采集反链 URL
4. 逐个打开 `https://data.similarweb.com/api/v1/data?domain=...`
5. 读取月访问量并导出 CSV

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

## 已知边界

- 不做断点续跑
- 不做 WebSpy 回退
- 不做冷却/重试调度
- 不直接用 `requests` 访问 Similarweb
- 如果 `sim.3ue.com` 页面结构变了，脚本会直接报错
