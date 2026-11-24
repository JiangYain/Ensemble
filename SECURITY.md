# Security Policy / 安全策略

## Reporting a vulnerability / 报告漏洞

Please report security issues privately: open the **Security** tab of this repository and choose **Report a vulnerability**. If that option is not available, open an issue that only asks for a private contact, without any details. Please do not post vulnerability details in a public issue.

请私下报告安全问题：在本仓库的 **Security** 页签里选择 **Report a vulnerability**。如果没有这个入口，可以开一个只请求私下联系方式、不写任何细节的 issue。请不要把漏洞细节发在公开的 issue 里。

## What to know before you use it / 使用前需要知道的

- Delegated sessions run with **Full Access** by default and Ensemble has no approval gate, so only delegate work you would let an agent do on your own machine. `access: "read_only"` is there for sessions that must not change anything.
- The local service listens on `127.0.0.1` only, and `/api/*` requires a token kept in `<ENSEMBLE_HOME>/run/service.json`. Ensemble has no telemetry.
- Session records under `<ENSEMBLE_HOME>/data/` can contain project content, and exported Markdown reports are **not redacted**: check them before sharing.

- 被委派的会话默认是 **Full Access**，Ensemble 没有授权闸门，所以只委派你愿意让一个 Agent 在自己机器上做的事。需要“不许改任何东西”的会话，用 `access: "read_only"`。
- 本地服务只监听 `127.0.0.1`，`/api/*` 需要令牌（保存在 `<ENSEMBLE_HOME>/run/service.json`）。Ensemble 没有遥测。
- `<ENSEMBLE_HOME>/data/` 下的会话记录里可能有项目内容，导出的 Markdown 报告**不做脱敏**，转给别人之前请先自己检查。
