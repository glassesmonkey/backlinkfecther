# 运行手册

## 这份文档解决什么问题

告诉你当前版本应该怎么跑、怎么判断任务结果、以及最常见的环境问题怎么排查。

## 什么时候读

- 想第一次在本机跑通。
- 想确认外部 Chrome shared CDP 模式该怎么配。
- 想看某个任务为什么落到 `WAITING_* / RETRYABLE / SKIPPED`。

## 最后验证对象

- `/Volumes/WD1T/outsea/backliner-helper/src/shared/browser-runtime.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/shared/preflight.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/cli/preflight.ts`
- `/Volumes/WD1T/outsea/backliner-helper/src/cli/run-next.ts`

## 运行原则

当前版本优先使用“外部 Chrome + shared CDP”：

- 你自己启动 Chrome。
- 项目通过 `connectOverCDP()` 连接同一个浏览器。
- 浏览器 profile、Google 登录态、插件、Cookie 都保留在这个外部 Chrome 里。

这样做的本质目的不是“更炫”，而是：

- 登录态可复用。
- 遇到人工认证时不需要重头开始。
- 真实目录站更接近手工浏览器环境。

## 启动方式

### Mac 验证通过的启动命令

```bash
open -na "/Applications/Google Chrome.app" --args \
  --remote-debugging-port=9223 \
  '--remote-allow-origins=*' \
  --user-data-dir=/tmp/chrome-cdp \
  about:blank
```

然后确认 CDP 正常：

```bash
curl http://127.0.0.1:9223/json/version
```

如果你看到 `Browser` 和 `webSocketDebuggerUrl`，说明浏览器可连。

### 连接项目

```bash
cd /Volumes/WD1T/outsea/backliner-helper
export BACKLINK_BROWSER_CDP_URL=http://127.0.0.1:9223
pnpm preflight
```

### 运行单任务

```bash
pnpm run-next -- \
  --task-id demo-futuretools \
  --directory-url https://futuretools.io/ \
  --promoted-url https://exactstatement.com/ \
  --submitter-email support@exactstatement.com \
  --confirm-submit
```

## `preflight` 现在检查什么

`pnpm preflight` 会把结果写到：

- `data/backlink-helper/runs/latest-preflight.json`

它当前会检查 4 项：

1. `cdp_runtime`
   - 是否能访问 `http://.../json/version`
   - 是否拿到浏览器元信息
2. `playwright`
   - 是否能 `connectOverCDP(cdp_url)`
   - 是否能看到已有 page 或新建 page
3. `browser_use_cli`
   - 只是检查命令是否在 `PATH`
   - 当前主链还没有真正调用它，只是确认最终兜底工具存在
4. `gog`
   - 只是检查命令是否在 `PATH`
   - 当前主链还没有把邮箱恢复做完整

注意：

- `runtime.ok` 目前只取决于 `cdp_runtime.ok && playwright.ok`。
- `browser_use_cli` 和 `gog` 失败不会让 `runtime.ok` 变成 false。

## `run-next` 会做什么

当前顺序固定是：

```text
resolveBrowserRuntime
-> runPreflight
-> load/create promoted profile
-> load/create task
-> replay (if playbook exists)
-> scout
-> takeover
-> write task/artifact/playbook
```

如果 `scout` 发现页面已经跳转到更稳定的 canonical URL，`run-next` 会先改写 `task.target_url`，再进入 `takeover`。

## 怎么读任务结果

### 成功类

- `DONE`
  - 当前代码基本还没稳定打到这个状态。
- `WAITING_SITE_RESPONSE`
  - 已经看到“待审核 / 已收到 / thank you”这类确认文案。

### 自动等待类

- `WAITING_EXTERNAL_EVENT`
  - 当前表示“等待邮箱验证 / magic link / confirmation email”。
  - 设计上应该由 `gog` 自动恢复。
  - 但当前 repo 里还没有完整的自动恢复 worker。

### 审计终态

- `WAITING_POLICY_DECISION`
  - 碰到 CAPTCHA、付费、赞助、业务策略点。
  - 这是审计终态，不会自动恢复到 `RUNNING`。
- `WAITING_MISSING_INPUT`
  - 表单有必填字段，但当前输入集不够。
  - 这是审计终态，不会自动恢复到 `RUNNING`。
- `WAITING_MANUAL_AUTH`
  - 遇到无人值守不支持的登录或认证。
  - 这是审计终态，不会自动恢复到 `RUNNING`。
- `WAITING_SITE_RESPONSE`
  - 站点已经接单，只是在等审核或发布。

### 可重试类

- `RETRYABLE`
  - 页面超时、上游 5xx、导航失败、结果无法确认、takeover 自己崩了。

### 终止类

- `SKIPPED`
  - 当前代码里很少主动落这个状态。
  - 北极星语义是：已经确定不值得继续自动化。

## OAuth 当前支持边界

先说本质：

- 当前 repo **没有** 通用 OAuth 自动化引擎。
- 但外部 Chrome profile 模式已经证明，**已有 Google 登录态的受限 OAuth 场景是可走通的**。

当前可成立的前提：

- 外部 Chrome 里已经登录 Google。
- 目录站的 OAuth 只是账号选择 + consent。
- 不要求输入密码。
- 不要求 2FA、验证码、设备确认。

当前不稳定或不支持的情况：

- 要求重新输入 Google 密码。
- 跳出 2FA / Passkey / 手机确认。
- 出现 CAPTCHA。
- OAuth 弹窗、回跳、登录成功确认需要复杂状态恢复。

遇到这些情况，当前运行手册建议直接转成审计终态：

- `WAITING_MANUAL_AUTH`
- 或 `WAITING_POLICY_DECISION`

## 常见故障排查

### 1. `curl http://127.0.0.1:9222/json/version` 没反应

先不要假设是代码坏了。最常见原因是：

- 端口被旧 Chrome 占了。
- `localhost` 和 `127.0.0.1` 指向的不是同一个监听。

做法：

- 换干净端口，比如 `9223` 或 `9224`
- 再重新启动 Chrome
- 再跑 `pnpm preflight`

当前 `preflight` 已经会提示这种 loopback 冲突。

### 2. 旧 headless 浏览器干扰

如果你之前跑过 `pnpm start-browser`，本机可能还残留一个 `9333` 上的 managed browser。  
当前 resolver 会优先探测外部 Chrome，但如果你显式传了别的 `cdp_url`，还是可能连错对象。

建议：

- 用显式的 `BACKLINK_BROWSER_CDP_URL`
- 或清掉旧进程后再跑

### 3. sticky header 挡住点击

当前 `takeover` 主要靠可见元素和启发式点击。  
如果页面顶部 sticky header 覆盖了按钮，常见现象是：

- 字段都填了
- 最终按钮没点上
- 任务落到 `RETRYABLE`

这类问题优先去看：

- 最新 `*-takeover.png`
- 最新 `*-takeover.json`

### 4. 站点其实是付费页

很多目录站不是“提交失败”，而是“登录成功后进入付费页”。  
当前运行上应该把它理解成：

- 自动化已经走到真实业务终点
- 只是业务决策不能自动做

例如：

- `AITopTools`
- `There’s An AI For That`
- `AIToolnet`

这些站点现在更适合在 playbook 里标成 `paid_listing`，下次登录后直接跳过。

### 5. Cloudflare 403 / 525

像 `aitoolsdirectory.com` 这种站，问题可能根本不在表单识别，而在目标站自己的可用性：

- Cloudflare challenge
- 上游 TLS handshake 失败
- 域名 apex / www 配置不一致

这类站不要先怪执行器，先看目录站是否真的健康。

## 推荐操作习惯

- 始终用单独的 `--user-data-dir`，不要连你的日常主力 Chrome profile。
- 一次只让一个 writer 操作共享浏览器。
- 先看 `latest-preflight.json`，再看 task JSON，最后看 artifact JSON 和截图。
- 看到“已登录但落到付费页”，优先记 casebook 和 playbook，不要继续浪费 token。
