# Ensemble

Ensemble is an [Agent Plugin](https://agent-plugins.org/) (MCP server + local service + web panel): your agent hands work to full Cursor, Codex, Pi, Claude Code, OpenCode and DSH sessions, and you watch and steer them live in a local web page.

It is built for agents, so let your agent install it. Paste this into Cursor, Codex, Claude Code, or any agent that can run shell commands:

```text
Please install Ensemble for me (npm package `ensemble-plugin`, source: https://github.com/JiangYain/Ensemble).
Node.js >= 22.13 is required. Run `npx -y ensemble-plugin@latest doctor` and tell me which harnesses are ready. Then install the plugin into the host you are running in with `npx -y ensemble-plugin@latest install cursor` or `install codex`: run it with `--dry-run` first, show me the plan, and re-run it with `--yes` only after I confirm. For any other host, run `npm install -g ensemble-plugin` and register `node <output of npm root -g>/ensemble-plugin/dist/ensemble.mjs mcp` as a stdio MCP server instead. If I want Cursor as an executor, also run `npx -y ensemble-plugin@latest install sdk --yes` and `npx -y ensemble-plugin@latest cursor-login` (it creates an API key in my Cursor account, so ask me first). When it is done, tell me to reload the window or restart the host, call the `harnesses` tool to confirm it works, and remind me that delegated sessions run with Full Access.
```

Full manual (in Chinese): [docs/manual.zh-CN.md](docs/manual.zh-CN.md) · License: [MIT](LICENSE)
