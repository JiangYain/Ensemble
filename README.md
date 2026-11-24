# Ensemble

Ensemble is an [Agent Plugin](https://agent-plugins.org/) (MCP server + local service + web panel): your agent hands work to full Cursor, Codex, Pi, Claude Code, OpenCode and DSH sessions, and you watch and steer them live in a local web page.

Ensemble 是一个 [Agent Plugin](https://agent-plugins.org/)（MCP 服务 + 本地服务 + 网页）：主 Agent 把工作委派给完整的 Cursor、Codex、Pi、Claude Code、OpenCode、DSH 会话，你在本地网页里实时观察、纠偏和接管。

It is built for agents, so let your agent install it. Paste this into Cursor, Codex, Claude Code, or any agent that can run shell commands:

```text
Please install Ensemble for me: https://github.com/JiangYain/Ensemble
Clone it somewhere outside my current project (Node.js >= 22.13 is required), run `node dist/ensemble.mjs doctor` and tell me which harnesses are ready. Then install the plugin into the host you are running in with `node dist/ensemble.mjs install cursor` or `install codex`: run it with `--dry-run` first, show me the plan, and re-run it with `--yes` only after I confirm. For any other host, register `node <clone>/dist/ensemble.mjs mcp` as a stdio MCP server instead. If I want Cursor as an executor, also run `node dist/ensemble.mjs install sdk --yes` and `node dist/ensemble.mjs cursor-login` (it creates an API key in my Cursor account, so ask me first). When it is done, tell me to reload the window or restart the host, call the `harnesses` tool to confirm it works, and remind me that delegated sessions run with Full Access.
```

它主要是给 Agent 用的，安装也交给 Agent。把下面这段话发给你的 Agent（Cursor、Codex、Claude Code 等任何能运行命令的 Agent）：

```text
请帮我安装 Ensemble：https://github.com/JiangYain/Ensemble
把仓库克隆到我当前项目之外的目录（需要 Node.js ≥ 22.13），运行 `node dist/ensemble.mjs doctor`，告诉我哪些执行端已经可用。然后用 `node dist/ensemble.mjs install cursor` 或 `install codex` 把插件装进你正在运行的宿主：先加 `--dry-run`，把计划给我看，我确认后再用 `--yes` 重新运行。其他宿主就把 `node <克隆目录>/dist/ensemble.mjs mcp` 注册成 stdio MCP 服务器。如果我要用 Cursor 作为执行端，再运行 `node dist/ensemble.mjs install sdk --yes` 和 `node dist/ensemble.mjs cursor-login`（后者会在我的 Cursor 账号里创建 API Key，先问我）。装完提醒我重新载入窗口或重启宿主，调用 `harnesses` 工具确认可用，并告诉我被委派的会话默认是 Full Access。
```

Details / 详细手册: [docs/manual.zh-CN.md](docs/manual.zh-CN.md) · License / 许可证: [MIT](LICENSE)
