# 站点案例册

## 这份文档解决什么问题

把已经验证过的目录站结论沉淀下来，避免下次又从零试一遍。

## 什么时候读

- 准备把一个站点加入批量任务前。
- 想知道某个站点值得继续自动化还是应该尽早跳过。
- 想把真实测试结果写回 playbook 或策略层。

## 最后验证对象

- `/Volumes/WD1T/outsea/backliner-helper/data/backlink-helper/tasks/`
- `/Volumes/WD1T/outsea/backliner-helper/data/backlink-helper/artifacts/`
- 手工 OAuth 截图证据 `aitoptools-oauth-manual-test.png`、`taaft-oauth-manual-test.png`

## 使用方式

这份案例册记录的是“站点层结论”，不是“某一次 task 的瞬时状态”。  
如果 task JSON 和案例结论冲突，以这里的复用结论为准，并回头修 takeover 规则。

## 站点总表

| site | entry_url | auth_mode | submit_surface | observed_terminal_class | recommended_playbook_action | last_verified_at | evidence_artifact |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `futuretools.io` | `https://futuretools.io/` | `direct_submit` | `https://futuretools.io/submit-a-tool` | `captcha_blocked` | `pause_for_policy_decision` | `2026-04-01` | `data/backlink-helper/artifacts/exactstatement-futuretools-takeover.json` |
| `aitoptools.com` | `https://aitoptools.com/` | `google_oauth` | `https://aitoptools.com/account/submit-tool/` | `paid_listing` | `skip_after_detection` | `2026-04-01` | `data/backlink-helper/artifacts/aitoptools-oauth-manual-test.png` |
| `theresanaiforthat.com` | `https://theresanaiforthat.com/launch/` | `profile_already_authenticated` | `https://theresanaiforthat.com/launch/` | `paid_listing` | `skip_after_detection` | `2026-04-01` | `data/backlink-helper/artifacts/taaft-oauth-manual-test.png` |
| `aitoolnet.com` | `https://www.aitoolnet.com/` | `login_then_paid_flow` | `https://www.aitoolnet.com/submit` | `paid_listing` | `skip_after_detection` | `2026-04-01` | `data/backlink-helper/artifacts/exactstatement-aitoolnet-takeover.json` |
| `aidirectory.org` | `https://www.aidirectory.org/` | `direct_submit` | `https://www.aidirectory.org/user-submit/` | `outcome_not_confirmed` | `retry_with_better_submit_detection` | `2026-04-01` | `data/backlink-helper/artifacts/exactstatement-aidirectory-takeover.json` |
| `aisupersmart.com` | `https://www.aisupersmart.com/` | `google_login_required` | `https://www.aisupersmart.com/submit-tool/` | `login_required` | `manual_auth_only_for_now` | `2026-04-01` | `data/backlink-helper/artifacts/exactstatement-aisupersmart-takeover.json` |
| `aitoolsdirectory.com` | `http://aitoolsdirectory.com/` | `none_verified` | `not_reached` | `upstream_5xx` | `skip_until_site_health_recovers` | `2026-04-01` | `data/backlink-helper/artifacts/exactstatement-aitoolsdirectory-scout.json` |

## 逐站说明

### `futuretools.io`

- `auth_mode`: 不需要先登录。
- `submit_surface`: `https://futuretools.io/submit-a-tool`
- 已验证事实：
  - takeover 能自动填 `Tool Name`、`Tool URL`、`Short Description`、`Category`、`Pricing`、`Your Email`
  - 点击 `Submit Tool` 后页面明确返回 `Please complete the captcha before submitting.`
- 复用结论：
  - 这是标准 `captcha_blocked`
  - 不该继续盲点，应转业务决策

### `aitoptools.com`

- `auth_mode`: Google OAuth 可走通
- `submit_surface`: `https://aitoptools.com/account/submit-tool/`
- 已验证事实：
  - 手工在 shared CDP 外部 Chrome 中点 `Continue with Google`
  - Google 账号选择和 consent 可完成
  - 登录后能进入站内提交页
  - 再提交会落到 `https://aitoptools.com/listed-now/` 付费确认页
- 复用结论：
  - 这个站的真正策略标签应该是 `paid_listing`
  - 下次不必再次探索是否能免费提交，登录后命中付费页就该跳过

### `theresanaiforthat.com`

- `auth_mode`: 当前验证 profile 已有登录态
- `submit_surface`: `https://theresanaiforthat.com/launch/`
- 已验证事实：
  - 当前外部 Chrome profile 已能直接进入提交流程
  - 提交 `Tool URL` 后会跳到 Stripe 结账页
  - 页面展示 `AI Submission + Newsletter (One-time payment)`
- 复用结论：
  - 这站也应标为 `paid_listing`
  - 推荐动作是 `skip_after_detection`

### `aitoolnet.com`

- `auth_mode`: 当前自动化 artifact 把它记成 `login_required`
- `submit_surface`: `https://www.aitoolnet.com/submit`
- 已验证事实：
  - takeover 已经真正进入 submit 页面并填了核心字段
  - 最终按钮文本就是 `Submit Pay $9.9`
  - body 里也明确出现 pricing plan
- 复用结论：
  - 站点层应归类为 `paid_listing`
  - 当前 task 状态偏向 `WAITING_MANUAL_AUTH` 是规则还不够准，不代表站点本质只是登录门槛

### `aidirectory.org`

- `auth_mode`: 直接表单提交
- `submit_surface`: `https://www.aidirectory.org/user-submit/`
- 已验证事实：
  - 自动化能进入 `user-submit` 页面并填多个字段
  - 当前版本没能确认最后提交结果
  - 页面还暴露了 `g-recaptcha-response` 等复杂校验信号
- 复用结论：
  - 先标成 `outcome_not_confirmed`
  - 优先补“最终提交按钮 / 成功页 / 校验错误”识别，不要先做更大的架构改造

### `aisupersmart.com`

- `auth_mode`: Google 登录必需
- `submit_surface`: `https://www.aisupersmart.com/submit-tool/`
- 已验证事实：
  - scout 会把 URL 规范化到 `https://www.aisupersmart.com/`
  - takeover 能进入 `/submit-tool/`
  - 页面正文明确写着 `Login with Google`
- 当前边界：
  - 页面登录入口受 LiteSpeed 延迟脚本影响
  - 这导致自动化入口识别和接手时机不够稳定
- 复用结论：
  - 当前先标 `manual_auth_only_for_now`
  - 等有稳定 OAuth helper 再继续推进

### `aitoolsdirectory.com`

- `auth_mode`: 未验证到可用提交面
- `submit_surface`: 未到达
- 已验证事实：
  - 当前自动化环境里 apex 域名导航不稳定
  - 后续手工复查还观察到 Cloudflare `525 SSL handshake failed`
- 复用结论：
  - 先按 `upstream_5xx` / `site_unhealthy` 处理
  - 不值得在当前阶段继续消耗 token

## 写案例时的规则

- 记录“站点规律”，不要记录 cookie、session、动态 checkout token。
- 遇到付费页、Stripe、sponsor、listed-now，统一写成：
  - `observed_terminal_class: paid_listing`
  - `recommended_playbook_action: skip_after_detection`
- 如果某次 task 状态和站点规律冲突，优先修规则，而不是复制错误结论。
