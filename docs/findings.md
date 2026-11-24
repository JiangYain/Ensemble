# 已核实的事实与证据

这份文档记录接入各个 Harness 和宿主时**真正查到、跑过**的结论，以及每条结论是怎么得到的。它与 `docs/research/mosoo-technical-reference.md`（研究结论与借鉴评估）分开维护：那份是调研，这份是在这台机器上的实测。

- 环境：Windows 11（10.0.26200）、Node 22.22.2、PowerShell；Codex 0.151.0、Pi 0.84.4、`@cursor/sdk` 1.3.1；日期 2026-11-07（第 2 节的授权复验、第 6 节的 Driver 副本与第 7 节的画布检查是 2026-11-08）；OpenCode 2.3.0 见第 10 节（日期 2026-11-15～16）；DSH 0.2.2-rc.1 见第 11 节（日期 2026-11-15～16）。
- 每条结论标注得到它的方式：
  - **【实测】** 在这台机器上对真实软件运行得到；
  - **【读码】** 阅读软件的源码或打包产物得到，没有真正运行；
  - **【文档】** 来自官方文档或规范原文；
  - **【推断】** 由上面的证据推出，没有被直接验证。
- 换了软件版本或操作系统后，这些结论需要重新验证。

## 1. Agent Plugins

**规范与校验**【文档】【实测】

- `plugin.json` 的 schema 是封闭的（未知字段不合法）；`mcp.json` 的 stdio 服务器 `command` 是单个可执行名（裸命令或 `./` 开头的插件内路径），`args` / `env` / `cwd` 里只展开 `${PLUGIN_ROOT}` 与 `${PLUGIN_DATA}`，`cwd` 默认是插件根目录；`skills/<name>/SKILL.md` 是固定的发现路径。
- `test/fixtures/agent-plugins/` 放的是 1.0.0 版两份 schema 的官方原文（2026-11-07 取自 agent-plugins.org）。`test/plugin-package.test.ts` 用 ajv 严格模式对本包的 `plugin.json`、`mcp.json` 做校验，并故意喂入非法输入确认校验器不是摆设。
- 刻意不使用 `${PLUGIN_DATA}`：它是各宿主私有的目录，而 Ensemble 的共享状态必须在不同宿主之间是同一个（`ENSEMBLE_HOME`）。

**Codex 0.151.0**【实测】（在隔离的 `CODEX_HOME` 里安装，没有碰真实配置）

- 读取根目录的 `plugin.json`、`extensions["com.openai"].interface`（显示名、图标、默认提示）、`mcp.json`（`${PLUGIN_ROOT}` 展开正确）和 `skills/` 目录；MCP 握手成功，工具列表可见。
- `codex plugin add` 会把插件复制进 `CODEX_HOME\plugins\cache\<市场>\<插件>\<版本>`，所以升级需要重新添加，或提升版本号。
- 个人市场文件是 `~/.agents/plugins/marketplace.json`（市场根是用户主目录）。
- Codex 通过系统的已知文件夹接口得到自己的主目录，所以想做隔离只能设 `CODEX_HOME`，改 `USERPROFILE` 无效。
- `codex delete --force <uuid>` 可以删除会话（没有 `--force` 在非交互终端里会拒绝）。

**Cursor（已安装版本）**【读码】——没有真正在 Cursor 里重新加载并调用过

- 识别 Agent Plugins 的 `$schema`；清单依次尝试 `.cursor-plugin/plugin.json`、`.claude-plugin/plugin.json`、`plugin.json`。
- 只展开 `${CURSOR_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}`，**不展开** `${PLUGIN_ROOT}`；先读 `.mcp.json` 再读 `mcp.json`（同名服务器先读到的生效）；清单里的 `mcpServers` 字段会覆盖；stdio 服务器的工作目录不会默认设为插件根。
- 据此，包里同时带了 `.cursor-plugin/plugin.json` 与 `.mcp.json`（用 `${CLAUDE_PLUGIN_ROOT}`），测试保证它与 `mcp.json` 定义同一个服务器。

## 2. Codex 作为发起端（经 MCP 委派）

方法【实测】：真实 Codex 0.151.0 的 `codex exec --ephemeral --ignore-user-config`，只用逐次调用的 `-c` 覆盖挂接 Ensemble 的 MCP 桥（不改任何持久配置；`--ephemeral` 不留会话；状态目录是临时的）；让一个便宜的模型调用 `harnesses` → `delegate`（Pi，只读）→ `wait` → `read`。

- 识别发起端：`clientInfo.name` 是 `codex-mcp-client`；每次工具调用的 `_meta` 里有 `x-codex-turn-metadata`（对象，含 `session_id`、`thread_id`、`turn_id`、`model`、`reasoning_effort`、`sandbox_mode` 等）以及 `threadId`、`itemId`、`callId`。Ensemble 用 `session_id` 作为发起会话，并把同一会话的多次调用归到一起。`_meta` 里**没有**工作目录。
- 没有收到 MCP `roots`：桥只能靠显式的 `cwd` 参数或自己的进程目录定位工作区。
- 批准（2026-11-07）【实测】：当时 `delegate` 标注为 `openWorldHint: true`。批准策略为 `never` 时它被 Codex 直接拒绝（`MCP tool call requires approval, but approval policy is never`），同一轮里 `harnesses`（只读标注）与 `wait` 不受影响；给 `delegate` 单独设 `-c mcp_servers.ensemble.tools.delegate.approval_mode="approve"` 之后调用通过。
- 批准（2026-11-08 复验）【实测】：现在 `delegate`、`send`、`cancel` 标注为 `readOnlyHint: false`、`destructiveHint: false`、`openWorldHint: false`。用 `codex exec --ephemeral --ignore-user-config --ignore-rules`，批准策略 `on-request`（非交互的 `exec` 会直接拒绝任何需要批准的调用），只用逐次调用的 `-c` 挂接桥（临时状态目录、专用端口、模拟执行端，没有产生真实的被委派会话）：`delegate`（Cursor 模拟，`[fixture:long]`）与随后的 `cancel` 都直接完成，没有被要求批准；会话从 `starting` 被中断为 `cancelled`。第一次尝试里模型把 `delegate` 的参数发给了 `cancel`，服务端以参数校验错误拒绝——那是模型选错了工具，不是批准问题；把提示改成明确的工具名后通过。没有验证的：Codex 交互界面里的批准提示、插件方式安装的服务器是否使用同一个配置路径、其他宿主的批准策略；也没有逐个标注做对照，所以只能说“现在的这组标注下免批准”，不能说是哪一个标注起的作用。
- 完整链路：委派 → Pi 只读会话运行（读取 3 个文件并答“3”）→ `wait` 返回“全部完成”→ `read` 取回答案；页面上的来源节点显示“由 Codex 派发 · 会话 01a1b6c3-9…”。两次运行（第二次是模型自己补上了 `cwd`）都成功。
- **进程树**：Codex 退出时，MCP 进程拉起的 `detached` 子进程**会被终止**；通过 WMI（`Win32_Process.Create`）创建的进程则**存活**。做法：一个探针 MCP 服务在启动时分别用两种方式拉起一个存活探针，`codex exec` 结束后检查——普通 detached 的探针已经退出，WMI 创建的仍在。因此 Ensemble 服务被桥拉起后，是否活过 Codex 取决于宿主清理进程树的方式；在 Windows + Codex 上它不会。`Win32_ProcessStartup.EnvironmentVariables` 可以向 WMI 创建的进程传环境（也实测过），但出于“不悄悄绕过宿主的进程管理”的考虑，没有把这条路接进产品（见 README“已知限制”）。
- 服务被强行终止后重启：已完成（空闲）的会话保持“已完成”，向同一个 Pi 会话追加消息会重新连上原生会话并开始第二次运行（页面和服务都验证过）。这条路径是这次检查中发现并修复的：以前空闲会话也会在服务退出时被标成“已失联”。

## 3. Pi（`pi --mode rpc`）

【实测】Pi 0.84.4 · Windows 11（`scripts/smoke.ts pi`：正常完成、运行中纠偏、取消、服务重启后的原生会话恢复、推理文本、只读工具白名单）。

- 协议：严格按 `\n` 切分的 JSONL。不能用 Node 的 `readline`——它还会按 U+2028 / U+2029 切分，会破坏合法的 JSON 字符串。
- 事件顺序：`message_end(assistant, stopReason=toolUse)` 先于 `tool_execution_start`；同一条助手消息里可以并行发起多个工具。
- 纠偏：`response steer` → `queue_update{steering:[原文]}` → 回合边界 → `message_start(user, 原文)`；只有最后一条才是“已生效”的证据。
- 取消：被取消的最后一条助手消息的 `stopReason` 是 `"error"`（`errorMessage` 为 “This operation was aborted”），不是 `"aborted"`；所以“取消”还是“失败”必须靠适配器自己记录的取消请求来判断。
- Pi 没有沙箱：只读靠工具白名单（`read,grep,find,ls`）强制；可写级别无法限定在工作区内。
- Pi 默认不弹授权；扩展的确认对话框无法由 Ensemble 代答（会被自动取消并记录）。
- 提问（2026-11-22 只读调查，没有运行 Pi；**没有实现转交**）：RPC 里的提问只来自**扩展**的对话框 `extension_ui_request`（`select` / `confirm` / `input` / `editor`，各可带 `timeout`，等 `extension_ui_response`；回复 `value`、`confirmed` 或 `cancelled: true`），没有内置的提问工具；随包的示例扩展 `question.ts` 只在 `ctx.mode === "tui"` 时提问，RPC 模式（`ctx.mode` 是 `"rpc"`）下直接返回 “UI not available”，`ctx.ui.custom()` 返回 `undefined`【读本机全局安装的 `@earendil-works/pi-coding-agent` 1.5.2 的 `docs/rpc-extension-ui.md` 与 `examples/extensions/question.ts`；本节验证的版本是 0.84.4，两者的行为是否一致没有核对】。Ensemble 现在把每个对话框都取消并记 `pi.extension_dialog`，因为分不清它是授权闸门（`confirm` 多半是；上游 Driver 就是用一个标题为 `mosoo.tool_permission` 的 `confirm` 对话框做权限中继）还是业务提问（`select` / `input` 才可能）。
- 以 `/` 开头的提示会被 Pi 当作命令解释。
- 在 Windows 上 npm 生成 `.cmd` / `.ps1` 垫片，直接 spawn `.cmd` 很脆弱，所以解析垫片、用 `node` 直接运行 JS 入口。结束进程要用 `taskkill /T /F` 结束整棵树（Windows 上工具子进程不会随父进程退出）。Linux / macOS 上的对应实现（读进程表、冻结后统一 SIGKILL）见第 11 节最后几条，已实现、未验证。
- 这台机器上 Pi 默认模型是 `github-copilot/claude-opus-5`、推理强度 `xhigh`；一个“数文件”的小任务花了约 $0.04、10k token（Pi 自己报告的用量）。

## 4. Codex（`codex app-server`）

【实测】Codex 0.151.0 · Windows 11（探针 + `scripts/smoke.ts codex`）。

- 协议：stdio 上每行一个 JSON，“精简版 JSON-RPC”（消息里没有 `jsonrpc` 字段）；服务端也会向客户端发请求（授权等），必须回应，否则服务端一直等。
- `turn/start` 立即返回 turn id；之后 `turn/started` → `item/started(userMessage，回显 clientId)` → … → `turn/completed`。
- `turn/steer` 立即被接受，但纠偏消息要等当前工具调用结束、下一次模型请求时才进入线程（`item/started userMessage`，`clientId` 原样回显）；所以“已生效”的证据是这条回显，而不是 `turn/steer` 的响应。
- `turn/interrupt` 约 10 ms 内生效，`turn/completed.status = interrupted`；被中断的命令不会再收到 `item/completed`。
- 沙箱：`read-only` 与 `workspace-write` 都由 Codex（Windows 沙箱）强制，工作区与临时目录之外的写入被拒绝。
- 授权（2026-11-07 的观察，现已不用）：在 `on-request` 下，沙箱挡住的写入触发 `item/commandExecution/requestApproval`；回复 accept 后命令在沙箱外执行，回复 decline 后命令状态为 `declined`，回合继续。按“被委派的 Agent 一律 Full Access、没有等待授权”的决定，Ensemble 现在以 `approvalPolicy: never` 启动所有 Codex 线程（Full Access 用 `danger-full-access`，只读用 `read-only`，被挡的写入直接失败而不是等批准）；适配器仍会回应万一收到的授权请求（Full Access 放行、只读拒绝，并记一条诊断），绝不让它变成“等待授权”。
- 推理摘要只有在 `turn/start` 带 `summary` 时才下发；用户配置里的默认模型可能不在可用目录里（`model_not_found`），所以必须显式给出可用模型。
- 通知 `turn/diff/updated` 每次带整份 diff，数据量很大，适配器不收。
- **（历史）权限中继不稳定**【实测，2026-11-07；该中继已随上一条的决定移除，这里只保留观察】：多轮真实冒烟里“拒绝”场景稳定通过；“批准”场景有时通过，有时模型根本没有发出提权请求（没有任何命令条目），有时批准之后命令始终没有报告完成（观察到过“系统拒绝启动命令进程”的提示）。原因没有查明；曾怀疑和同时存活的 app-server / MCP 进程数量有关，没有得到证实，不当作结论。适配器如实转达批准，并在 Codex 从未报告完成时把该工具显示为“未完成”。
- 业务提问（2026-11-22 起转交；这是读代码与协议类型声明得来的，**只对着模拟的 app-server 验证过，真实 Codex 没有触发过提问**）：模型调用 `request_user_input` 时，app-server 发来服务端请求 `item/tool/requestUserInput`（每个问题有 id、标题、问题文字、可选项 `{label, description}`、`isOther`、`isSecret`；请求里还有 `isBlocking`）【读 `vendor/mosoo-agent-driver` 里生成的协议类型，上游 Driver 对它只回“不支持”；协议里把这个请求标着 EXPERIMENTAL，字段以后可能变】。Ensemble 把它转成统一的提问记录（见 README“子会话的提问”），回答时回 `{ answers: { <问题 id>: { answers: [标签…] } } }`，不回答回 JSON-RPC 错误 `-32000`（附主 Agent / 用户的备注）【回复形状是从 Codex 二进制里的结构名（`ToolRequestUserInputAnswer`）推断的，没有真实核对；自填文字按普通字符串给（Codex 自己的 TUI 会给备注加 `user_note: ` 前缀，这里没有照做），是否被原样接受、`isBlocking: false` 时 Codex 怎样处理请求，都没有核对，后者退回旧做法（回错误并记诊断）】。`isSecret` 的问题整个不转交（立即回错误，只记一条不含问题文字的诊断；退回老办法的 `codex.question_unanswered` 诊断也不引用机密类条目的文字，其余条目的原文先脱敏再截断）；判断先于对条目的解析，缺 `id` 或问题正文、转交读不出的机密条目同样让整个请求不转交（诊断码 `codex.question_secret`；接上转交时，含机密条目的请求在解析条目之前就被拒绝，走不到 `codex.question_unanswered`，那条诊断里对机密条目的处理只是纵深防御）。`serverRequest/resolved` 到来说明 Codex 已不再等待，提问记为过期。授权类请求（`item/commandExecution|fileChange|permissions/requestApproval`）的处理一个字没改。`mcpServer/elicitation/request` 也没有改，仍然取消并记诊断：它是 MCP 服务器发起的任意 JSON 表单（还可能是跳转链接或凭据），不是“模型问用户一个问题”。
- 不支持的部分：Codex 自己发起的、不是 Ensemble 请求的回合不会被追踪；用 shell 命令写入的文件不会被逐个列出（`apply_patch` 的改动有逐文件事件）。

## 5. Cursor（`@cursor/sdk`）

- 依据 SDK 1.3.1 的类型定义与打包源码编写适配器【读码】：
  - `assistant` / `thinking` 消息是增量（`text-delta` / `thinking-delta`），推理结束用 `text: ""` 加 `thinking_duration_ms` 表示；
  - `tool_call` 开始与增量都是 running，完成时才带 `result`，`status: "error"` 表示失败；本地运行实际产出 `{status:"success",value}` 或 `{status:"error",error:{message,path?}}`；
  - `Run.steer()` 可选：本地控制器不支持时 SDK 自己返回 `revert_to_followup`（应当作普通跟进发出），控制器接受后会一直挂起到回合真正追加了消息才返回 `complete_delivered`；
  - `Run.cancel()` 立即把状态置为 cancelled；`Agent.resume(id, { local: { cwd } })` 恢复，`tools` 不随会话持久化，恢复时要重新传；进程崩溃后残留的运行用 `send(..., { local: { force: true } })` 过期。
- 许可证不允许随插件分发 SDK：不打进 `dist/`，运行时按“`ENSEMBLE_CURSOR_SDK` 指定目录 → 随包安装 → `<ENSEMBLE_HOME>/runtime`”的顺序加载。通过隔离的假 `USERPROFILE` 对真实 SDK 跑过 `doctor`、`cursor-login --status` 和非交互拒绝登录【实测】。
- **历史观察（2026-11-08）**：当时 Ensemble 的 Cursor 执行端读到的登录被 Cursor 拒绝。2026-11-14 已经通过 Ensemble 完成一次真实只读运行；纠偏、取消、恢复和只读强制仍待分别以真实账号验证。Ensemble 不读取、不转存 Cursor 的凭据文件，登录只通过 `cursor-login` 或 `CURSOR_API_KEY`。
- 2026-11-08 起 Cursor 执行端经 `vendor/mosoo-agent-driver` 里新增的 Cursor SDK 后端驱动【实测：测试通过；没有真实账号】：Kernel 与后端是真实代码，SDK 是按 1.3.1 类型编写的假实现。事件翻译、纠偏三种结果与迟到的结论、取消（含放弃路径）、恢复、只读白名单、凭据不外泄都有测试（`src/server/driver/*.test.ts`、`src/server/executors/cursor*.test.ts`）。
- 假 SDK 的测试漏掉过一个真实问题【实测：用随包安装的真实 SDK 跑加载测试时发现】：vendored 后端的默认加载器与导出校验把 `Agent` 当成普通对象；真实 SDK 的 `Agent` / `Cursor` 是带静态方法的类（`typeof` 为 `function`），于是真实 SDK 会被判成“不是 SDK”。已改为 `isSdkExport`（对象或函数都算导出存在），回归测试在 `src/server/executors/cursor-sdk-loader.test.ts`，宿主加载器与后端自带的默认加载器两条路径都覆盖。
- 真实返回的形状（2026-11-08，只读核对）【实测，SDK 1.0.28】：经你自己的 Cursor SDK 网关调用了 `auth.status` 和 `models.list` 两个只读接口；没有启动任何 Agent，没有读取或打印任何密钥。
  - `Cursor.auth.status()` → `{ status, backendUrl, email, apiKeyExpiresAtMs }`，和探测代码读取的字段一致（`status` 为 `logged-out` 才算没登录）。它只反映本地保存的凭据，不代表服务端接受。
  - `Cursor.models.list()` → `[{ id, displayName, aliases?, parameters?: [{ id, displayName, values: [{ value, displayName? }] }], variants?: [{ params: [{ id, value }], displayName, isDefault?, isMaxMode? }] }]`。Auto 的 id 是 **`default`**、别名是 `auto`；推理档位参数叫 `reasoning_effort`，和 `context`、`fast` 并列。
  - 据此修正了一处假设：默认模型原先只认 id `auto`，真实目录里它叫 `default`，只有恰好排在第一个才会选对；现在 id 和别名都认，并按真实形状补了测试（`cursor-options.test.ts` 的 “Cursor catalog in the real shape”）。
  - 只传 `reasoning_effort`、不传 `context` / `fast` 的做法有 SDK 类型注释支撑：`ModelSelection.params` 可以只给一部分，SDK 按与 `params` 一致的目录变体决定是否带 max mode【读码，SDK 1.3.1】；服务端是否照单接受：下面那次真实运行里只带 `reasoning_effort` 的参数被接受了，但有并列参数的模型（如 Grok 4.7）没有试过。
  - 这台机器上两条路径的结果不同：网关（它自己保存的凭据）能列出模型，而 Ensemble 自己的 SDK 1.3.1 读到的登录仍被 Cursor 拒绝（`Invalid User API Key`，`doctor` 里每次都复现）。所以“网关能用”不等于“Ensemble 的 Cursor 执行端能用”，后者仍需要你运行 `cursor-login` 或设置 `CURSOR_API_KEY`。
- 一次真实运行（2026-11-08，你同意后经网关，SDK 1.0.28）【实测】：空临时目录（只有一个 `hello.txt`）、`settingSources: []`、`tools` 只给 `ls` / `read` / `glob` / `grep`、一句话任务；模型 `deepseek-v41-flash-1017`（网关只放行它和 `claude-sonnet-5-5`，不接受 `default` / Auto）；7.7 秒、6478 token；运行后目录原样。
  - 事件顺序：`status RUNNING` → `thinking` 增量（以 `text: ""` + `thinking_duration_ms` 收尾）→ `tool_call` running → completed（glob 的参数是 `globPattern` / `targetDirectory`，结果 `{ status: "success", value: { files, totalFiles, clientTruncated, ripgrepTruncated } }`，路径是 SDK 自己写的 `../.\hello.txt`）→ 第二段 `thinking` → `assistant` 增量 → `usage`（带 `reasoningTokens`）→ `status FINISHED`。**没有 `system` 消息**，所以适配器不能依赖它。
  - 已做成回放测试（`cursor-events.test.ts` 的 “replays a real run…”）：适配器不用改就通过，`status` / `usage` 不产生诊断噪音，思考时长、工具结果、最终回答与用量（含推理 token）都对得上。
  - 模型自述“没有 `ls` 工具，只有 Glob / Grep / Read”：`tools` 白名单看来起了作用，不认识的名字被悄悄忽略而不是抛错；但这只是模型的自述加一次调用，**不算验证只读强制**（没有让它尝试写文件）。
  - 模型的思考里出现了“需要简体中文回答”，和你的账号级用户规则一致，但来源没有查明（也可能是网关自己加的）。若是账号级规则，`settingSources: []` 就挡不住它：Ensemble 委派出去的 Cursor 会话会带着这些规则，而它们不在页面展示的“传入的上下文”里。
  - 没有试过：纠偏、取消、恢复、失败路径、`system` 消息（SDK 1.3.1 是否会发）、Ensemble 自己的 SDK 1.3.1 与凭据。
- 本地运行没有交互式授权通道（工具直接执行）：Cursor 会话本来就是 Full Access，没有授权可言。
- 提问（2026-11-22 只读调查，没有运行 SDK；**没有实现转交，也转交不了**）：SDK 的工具名里有 `askQuestion`（`ToolName` 类型），但本机安装的 `@cursor/sdk` 1.3.1 在本地运行里自己把 `askQuestionInteractionQuery` 应答成“拒绝”（原因文字 “Interactive questions are not supported in local SDK runs”；子 Agent 模式下是 “…in local subagent mode”），公开接口里没有让宿主应答的口子（`InteractionListener` 只有向外推更新的 `sendUpdate`）【读 `node_modules/@cursor/sdk/dist/esm` 里的类型声明与打包后的代码】。所以 Cursor 会话里的模型若调用它，得到的是一个拒绝；流里的 `request` 消息只带 `request_id`，只记一条 `cursor.request` 诊断。

## 6. `@mosoo/agent-driver`（Driver）在 Windows 上

【读码】【实测】——结论（2026-11-08 更新；此前的结论是“没有接入”）：**按你的决定把源码复制到本地接入 Kernel，并新增 Cursor SDK 后端；上游的 Pi / Codex 后端仍不可用。**

- 查询时它没有发布在 npm（registry 返回 404）；`exports` 默认入口指向 TypeScript 源码 `./src/index.ts`，类型路径指向仓库里并不存在的 `dist`（构建后才有），所以是 Bun 优先的包；`engines` 要求 Bun ≥ 1.4.0（本机全局是 1.3.8，另在临时目录里用 npm 装了 1.4.4 做实验）。
- 模型接入走“代理授权”：每个 Codex app-server 拿到一份私有的临时 `CODEX_HOME`，只接受由执行自己的模型连接提供的 API Key 认证——也就是**不会复用用户已有的 ChatGPT 订阅登录**，这和 Ensemble “驱动用户已经登录的 Harness”的目标不一致。
- 在这台 Windows 机器上用 Bun 1.4.4 实测：Driver 模块能加载，但它的 POSIX 路径 schema 会拒绝 `C:\...` 路径，`openRealDirectory` 需要 Linux 的 `/proc` 能力。因此它的 Pi / Codex 后端无法在原生 Windows 上运行。
- 对 Driver 仓库做完整 `bun install` 卡了 11 分钟以上，被我终止（它的开发依赖很重）。
- 上游没有 Cursor 后端，Cursor 本来就需要单独适配。
- 处理方式（2026-11-08，按你的决定）：不用 npm 版（它也没有发布），而是把 Driver 源码复制到 `vendor/mosoo-agent-driver`（锁定提交 `49df36e…`，Apache-2.0，逐文件修改清单见 `VENDORING.md`），裁掉与进程内嵌入无关的部分，并在里面新增 Cursor SDK 后端；`CursorExecutor.open()` 经 Kernel 驱动 Cursor 会话。Kernel 在 Windows + Node 22.22.2 上加载并跑通了测试【实测，Cursor SDK 为假实现】；上游用到 `Promise.try`（Node 22 没有），宿主里补了一个等价实现。上游的 Pi / Codex 后端（`runtimes/pi`、`runtimes/openai`）带着 POSIX 路径与 `/proc` 假设，目录保留只为和上游对照，**没有登记、运行时不可达、没有验证**；Codex 与 Pi 仍由 Ensemble 直接对接各自的控制接口。统一事件模型是 Ensemble 自己定义的，Driver 事件只在 Cursor 这一路被翻译成 Ensemble 事件。

## 7. Ensemble 自身在真实数据下的检查

【实测】

- 用上面第 2 节产生的真实事件记录启动服务、在浏览器里打开页面：来源节点、Pi 节点（10 段进度条已满、用时、模型）、聚焦视图（委派原文、投递三步证据、工具步骤、答案、用量）、以及追加消息后的第二次运行都按预期显示。
- 服务被强行终止后，已完成的会话不再被标成“已失联”；仍有在途工作（运行中、排队的运行、或还握在 Ensemble 手里没交给执行端的消息）的会话仍会被标为失联，未完成的运行如实记为失败并说明原因（单元测试覆盖两条路径）。
- 之前用模拟执行端对界面做过逐项的视觉检查（窄 / 宽、中 / 英、对话框、菜单、取消 / 中断、长会话窗口化），页面只对着模拟执行端和上面这一条真实记录检查过。
- 画布（2026-11-08，按一段参考视频近 1:1 重做；该视频不随仓库发布，也已不再约束设计，这条只记录当时的核对）【实测】：在真实浏览器里以 1440×810、2 倍像素渲染，与视频抽出的原生分辨率帧逐项对照——卡片与凹槽的颜色、缺口与凸耳的几何、管线粗细与弯角半径、管线点阵与流动的数据包、字号字重与字色、状态符号、10 段进度条、头部图标；窄宽度（440 / 360 px）下顶栏会按宽度让位。边界：视频是压缩过的帧，颜色与字重只能对到取样与肉眼允许的精度；管线流动的节奏只按观察近似，没有逐帧测时；视频里没有悬停、菜单、键盘焦点、减少动态效果的画面，所以这几个状态没有参考可对：我在真实浏览器里强制伪类（悬停、焦点）并模拟 `prefers-reduced-motion` 后截图看过——悬停才出现“···”、菜单展开后按钮按下态与分隔线 / 禁用项、键盘焦点环、减少动态效果时管线停成静态点阵，只检查了观感与自洽；工具提示的定位与延迟没有逐一截图。

## 8. 尚未验证

- Cursor 作为发起端的实际加载与调用；其执行端在真实账号上的纠偏、取消、恢复和只读强制。
- 在真实 Codex 的交互界面里，插件方式安装后的完整流程（批准提示、插件服务器的配置路径、默认 `cwd`）。
- Driver 副本里的 Cursor SDK 后端在真实账号上的纠偏、取消、恢复、失败路径与只读强制；上游的 Pi / Codex 后端（见上）。
- 非 Windows 平台上的任何行为。
- 长时间（数十分钟以上）运行、很多会话并发时的资源占用。
- OpenCode 在用户自己的真实配置（多个提供商、MCP、插件）下的行为；上下文压缩期间的用量；子 Agent（`task` 工具）子会话在取消时的行为；`delivery:"queue"`；经 `.cmd` 外壳启动（详见第 10 节）。
- DSH：真实的 DeepSeek 模型运行（本机没有 DeepSeek 凭据，只用脚本化的假模型端点验证过）及其用量口径；真实的 429 / 5xx 重试表现；用户自己的 `~/.dsh` 配置（插件、MCP）下的行为；`delivery:"queue"`；在官方声明的 Node ≥ 24.9.0 下运行（只在 Node 22.22.2 上验证）；Linux 与 macOS（整个适配器都没有在这两个系统上跑过；取消后的孤儿清理与“结束整棵进程树”已实现、没有验证，详见第 10、11 节）。

## 9. Claude Code（`claude -p`）

【2026-11-14：真实 CLI + 本地模拟模型服务，非真实模型验证】

- 官方的 [程序化运行接口](https://code.claude.com/docs/en/headless) 支持流式 JSON 和原生会话续接；适配器调用本机 Claude Code CLI，不把它当作单次模型请求。按初始化与用户消息回放的证据确认会话及投递状态，进程退出且收到成功结果后才记录完成。
- Windows 上以真实 CLI 2.1.325 和隔离的本地模拟服务验证：读取临时文件的 `Read` 工具调用、原生会话 ID 续接及上下文、取消运行后继续下一轮。运行中补充消息排到下一轮；适配器不声称即时纠偏。
- 只读使用 CLI 的 `--safe-mode`、严格 MCP 配置与 `Read,Glob,Grep` 工具白名单，检查初始化事件中的工具列表；这是工具层限制，不是操作系统沙箱。Full Access 使用 `bypassPermissions`。参考 [CLI 文档](https://code.claude.com/docs/en/cli-reference)。
- 本机现有模型服务调用反复重试，未得到有效结果，原因未查明；账号与模型服务的真实端到端运行未验证，能力状态保持 `declared`。自动化测试覆盖异常启动、无结果、只读工具不符、排队和取消等路径。
- 提问（2026-11-22 只读调查，没有运行 Claude Code；**没有实现转交**）：官方 Agent SDK 文档写明 Claude 用 `AskUserQuestion` 工具提问，经 `canUseTool` 回调交给宿主（每次 1–4 个问题、每题 2–4 个选项，子 Agent 里不可用；用 `tools` 限定工具时要把它列进去）；`claude -p` 的无头文档写明，手动权限模式下需要批准的调用在没有宿主（`PermissionRequest` 钩子或 `--permission-prompt-tool`）批准时被拒绝，`AskUserQuestion` 即使有允许规则也同样被拒绝【读 [用户输入](https://code.claude.com/docs/en/agent-sdk/user-input) 与 [无头模式](https://code.claude.com/docs/en/headless) 在 2026-11-22 取到的版本】。Ensemble 的 `claude -p` 用 `bypassPermissions`、没有接任何宿主，只读用 `--tools Read,Glob,Grep`（按文档不含 `AskUserQuestion`）：Full Access 下它提问会怎样没有实测，只读下按文档提不了问。上游 Driver 的 Claude 后端不在本地副本里（`VENDORING.md` 记着它被排除），没有对照物；`--permission-prompt-tool` 能否接住 `AskUserQuestion` 没有核对。

## 10. OpenCode（`opencode serve --stdio`）

【2026-11-15～16：真实 OpenCode 2.3.0 + 免费模型 `opencode/deepseek-v4.1-flash-free`；用的是隔离的家目录与我自己写的最小配置，没有读取 `auth.json`、`opencode.json` 或任何环境里的密钥】

- 来源与版本：npm 包 `@opencode/cli`（MIT，仓库 `anomalyco/opencode`）【文档】；本机 2.3.0，装在 npm 全局目录【实测】。Windows 上 `opencode.cmd` 只是转发壳，真正的可执行文件在平台包里：`cli-windows-x64-baseline\bin\opencode.exe` 能运行；同级的 `cli-windows-x64` 里的文件被截断；`@opencode/cli\bin\opencode.exe` 只是 229 字节的占位文件【实测】。所以适配器对每个候选都执行一次 `--version`，跳过跑不起来的；`.cmd` 只解析、从不执行【读码，有单元测试】。
- 控制路径：每个会话一个私有 `opencode serve --stdio --hostname 127.0.0.1 --port 0`（标准输出第一行是 `{"url":"http://127.0.0.1:端口"}`，标准输入一关就退出；每个进程一个随机 `OPENCODE_PASSWORD`，HTTP Basic），加 REST `/api/*` 与 SSE `GET /api/event`（首帧 `server.connected`，每 15 秒一次心跳）【实测，接口形状按服务自带的 OpenAPI 描述核对】。没有选 ACP（`opencode acp` 没有运行中补充输入）和 `opencode run --format json`（不能纠偏，也没有优雅取消）【文档 + 读码】。
- 模型与档位：`GET /api/model` 给出目录（隔离环境里探测到 54 个模型，档位取自各模型自己的 `variants`），`GET /api/model/default` 给出默认模型【实测】。目录对象里带凭据的设置字段从不拷贝，只取模型名、提供商、档位与上下文窗口；OpenCode 的错误文本、stderr、探测失败信息与 HTTP 错误详情里的 bearer token、`sk-` 一类密钥形态以及 `api_key=…` 这类键值对，在写进事件或日志前先脱敏（有断言）；模型输出和工具输出是任务内容本身，不做脱敏。
- 运行事件：文本、推理、工具开始与结束、shell 命令及退出码、文件变更、用量、`opencode.retry`（真实遇到过一次 ECONNRESET 重试，作为诊断展示）【实测】。`startRun` 在 OpenCode 接受提示后立即返回。文件变更只取自 `edit` 的结果元数据与 `write` 的回执，所以能力标为 `partial`；shell 与代码模式里的写入看不到。用量口径：输入 = input + cacheRead + cacheWrite，输出 = output + reasoning，按步骤累计。Windows 上 PowerShell 的 `-Command` 会把任何失败的原生命令都报成退出码 1，OpenCode 照实转述，适配器也如实呈现为“失败 + 非零退出码”【实测】。
- 访问级别：创建会话时写入会话级权限规则（有序的 `{action,resource,effect}`，后匹配者生效），不修改任何 `opencode.json`【实测】。Full Access 放行所有工具，实测盖过了我在隔离配置里把 shell 与编辑设成 `ask` 的 agent 规则，全程没有授权请求；只读只放行 `read` / `glob` / `grep`，其余工具被拒绝并从模型看到的工具列表里隐藏，要求它写文件时没有写出文件；2026-11-22 之前两种级别下 `question` 都被拒绝（模型因此只能瞎猜），现在两种级别下都放行并转交，见下一条。万一仍收到权限请求的兜底（Full Access 放行、只读拒绝）只在模拟服务上验证过，真实 OpenCode 没有触发；这条路径一个字没改。
- 业务提问（2026-11-22 起转交；**形状读自 2.3.0 的随包源码，只对着模拟的 OpenCode 验证过，真实 OpenCode 没有触发过提问**）：模型调用 `question` 工具时，事件流里出现 `form.created`（`metadata.kind` 为 `"question"`；`fields` 里每个字段有 `key`、`title`、`description`、`type`〔`string` 或 `multiselect`〕、`options`〔`{value, label, description}`〕、`custom`）。回答是 `POST /api/session/{id}/form/{formID}/reply`，体 `{ answer: { <key>: 所选选项的 value | 自填文字 | value 数组 } }`；不回答是 `DELETE …/form/{formID}?message=<备注>`；`form.replied` / `form.cancelled` 是 OpenCode 已结清这个表单的信号（我们自己正在回复时，它的回声被忽略）。读不懂形状、没有进行中的运行、条数或长度超出上限的 question 表单，立刻 `DELETE` 并附一句“请自行判断”的说明、同时记诊断，运行继续；不是 question 的表单（`metadata.kind` 不是 `question`）仍按老办法：取消这个表单，这一轮以失败收尾（诊断码 `opencode.question_unanswered`；原因文字里引用的表单标题先脱敏（`redact` 只认得出少数密钥形状）、再压成一行并截到 120 字，这句话同时是诊断和这一轮失败的原因）。`custom` 缺省按“允许自填”处理，选项的 `value` 与 `label` 哪个该作为答案以 `value` 为准，这两处都没有在真实 OpenCode 上核对。
- 纠偏：`POST /api/session/{id}/prompt` 带 `delivery:"steer"`，消息进收件箱，在下一个步骤边界由 `session.inbox.delivered` 取走——这个事件就是“已生效”的证据【实测】。取走之前可以 `DELETE …/inbox/{inboxID}` 撤回；适配器在取消或运行结束时撤回还没被取走的纠偏，这条路径只在模拟服务上验证过。
- 取消：OpenCode 自带的 `POST …/interrupt?resume=false` 只结束 shell 工具那一层（`pwsh.exe`），它启动的子进程会变成孤儿；进程树是 `opencode.exe`（服务）← `opencode-pty.exe` ← `pwsh.exe` ← `node.exe` 等【实测】。适配器因此先按 pid 执行 `taskkill /pid <shell> /T /F`（pid 取自 `shell.created` 事件与 `GET /api/shell` 登记表的并集；`shell.exited` 事件比进程真正退出晚约 0.9 秒，不能当触发条件），**根进程一消失就发中断**（上限 3 秒），再等 taskkill 收尾。先等 taskkill 完整结束再中断会让模型在 1.5～2.5 秒的空档里接着走下一步，运行以“已完成”收尾而不是“已取消”——这是实测踩到的。连续 5 轮共 30 项检查全部通过：运行以已取消收尾、工具进程全部消失、同一会话还能继续下一轮；正在生成文字时取消、`stop` 也一样。关闭会话同样先停运行与工具进程，空闲时关闭不发中断。Linux 与 macOS：同一套流程，只是“结束整棵树”换成 `process-kill.ts` 的冻结收敛（读进程表沿 ppid 找后代，SIGSTOP 冻结到收敛，统一 SIGKILL，用进程表确认；取消路径强制、不先发 SIGTERM，细节见第 11 节最后几条），**已实现、没有在真实系统上验证**；OpenCode 的中断在那里是否同样只杀 shell 那一层、shell 的根进程是否是服务进程的后代（不是的话 `killTree` 会拒绝动手，而不是猜着杀）都没有观察过【读码；测试用模拟的进程世界与真实的 node 进程树写成，没有运行过】。
- 继续与恢复：第二轮用同一个原生会话 ID，上下文保留；Ensemble 服务重启后用同一个原生会话 ID 重新拉起私有服务并继续，包括在工具运行到一半时关闭服务之后【实测】，`canResume = true` 以此为据。会话与消息留在 OpenCode 自己的数据库里，标题被改成委派标题（`PATCH /api/session/{id}`）。
- 嵌套委派环境：`ENSEMBLE_PARENT_SESSION` 与 `ENSEMBLE_PARENT_DEPTH` 写进私有服务进程的环境，会话里的 shell 工具读到了 `S=<id> D=0`【实测】；OpenCode 自己启动的 MCP 进程是否继承没有核对。
- Windows：中文与带空格的工作目录、`windowsHide`、整棵进程树清理、结束后没有残留的 `opencode.exe` 或工具进程【实测】；每个私有服务约占 145–281 MB 内存。
- 没有验证的：用用户自己的真实配置（多个提供商、MCP、插件）运行——私有服务会加载那份配置，其中的插件与 MCP 会随每个会话各起一份；上下文压缩期间的用量；子 Agent（`task` 工具）开出的子会话在取消时的行为；`delivery:"queue"`；非 Windows 平台；经 `.cmd` 外壳启动。

## 11. DSH（`dsh --profile acp`）

【2026-11-15～16：真实 dsh 0.2.2-rc.1（DeepSeek Harness 的开发者预览版）+ 我自己写的脚本化假模型端点；用的是隔离的 `DSH_HOME`（外加一个只声明假模型的 `--patch` 层），没有读取 `~/.dsh\.credentials.yaml`、任何环境里的密钥或登录文件，也没有用真实的 DeepSeek 模型跑过】

- 来源与版本：npm 包 `@deepseek-ai/dsh`（MIT，仓库 `deepseek-ai/deepseek-harness`；npm 上只有预发布版本）【文档】。`npm install -g @deepseek-ai/dsh`（不带标签）报 `ETARGET`，必须 `npm install -g @deepseek-ai/dsh@latest`；本机装的是 0.2.2-rc.1：654 个包、89 秒，装进 npm 全局目录（`%APPDATA%\npm`），PATH 没有改动，`~/.dsh` 里没有新增任何东西（装前装后的清单逐项相同）【实测】。包声明 `engines.node >=24.9.0`（npm 报 `EBADENGINE`），在本机 Node 22.22.2 上 `dsh --version` 与 acp profile 都正常工作——这是“实测可用”，不是官方支持的组合；适配器在会话时间线里留一条 `dsh.node_version` 说明，不据此拒绝启动，也没有升级本机的 Node【实测】。Windows 上全局安装的 `dsh.cmd` 只是转发壳，适配器解析出它指向的 JS 入口，用 `node` 直接运行，不经 `cmd`【实测 + 单元测试】。
- 控制路径：官方有两条——`dsh --profile acp`（ACP v1，stdio 上的 JSON-RPC 2.0）和 SDK 档。选 ACP，因为 SDK 档没有取消，也拿不到一轮对话的结束结果【读码 + 文档】。用到的方法：`initialize`、`session/new`、`session/prompt`（响应就是这一轮的结束，带 `stopReason`）、`session/cancel`（通知）、`session/resume`、`session/set_config_option`（`model`、`reasoning_effort`）；dsh 主动发来的请求只见到 `session/request_permission`【实测】。
- 事件形状：更新是整块提交的（没有逐字流）；`session/prompt` 发出后到第一条 `session/update` 之间什么都没有（整个第一次模型调用期间），所以“这一轮已开始”的证据只能取第一条更新（或直接给出的结果）——否则第一次调用就 401 时，模型从没见过这条消息，却会被记成“已生效”。工具以 `tool_call` / `tool_call_update` 上报，工具名与入参：`write{file_path,content}`、`edit{file_path,old_string,new_string}`、`pwsh{description,command}`、`read{file_path}`、`todo_write{todos}`。`pwsh` 的非零退出码 dsh 仍报 `completed`，只在结果文本里带退出码，适配器据此记为“失败 + 退出码”；`usage_update` 给出上下文用量（e2e 里是 7104 / 1,000,000）【实测】。
- 访问级别：环境变量 `DSH_PERMISSION_MODE`（`read-only | workspace-write | danger-full-access`）盖过用户 `settings.yaml` 里的权限设置，所以 Ensemble 不用改动用户的任何 dsh 配置；工具的子进程里读不到这个变量；acp profile 也不读 `settings.yaml` 里的 models / providers【实测】。`danger-full-access` 下全程没有授权请求。`read-only` 下写入工具失败 `[sandbox: file access denied under read-only mode]`，shell 写入被拒（工作目录内外都一样）；模型随后带 `sandbox_permissions:"danger-full-access"` 重试时，dsh 发出 `session/request_permission`（选项 allow-once / reject-once）——客户端选 reject-once，dsh 回报被拒绝，文件没有写出；这条在直连 ACP 与 Ensemble 适配器两条路径上都验证过（适配器留下 `dsh.approval_declined` 诊断，运行正常结束，没有卡在授权上）【实测】。
- 纠偏：dsh 一次只收一个 prompt，运行中再发 `session/prompt` 被拒（`-32602`），文字不会被注入【实测】，所以纠偏映射为 `needs_follow_up`（排队，这一轮结束后作为新的运行发送）。端到端：投递依次是 `recorded → queued(run_in_progress) → handed_off → applied`，补充的文字在第二轮到达了模型【实测】。
- 取消：`session/cancel` 约 35 毫秒内让这一轮以 `stopReason: cancelled` 收尾，会话照常继续；但 dsh 只结束工具的那层 `pwsh`，工具再启动的子进程会变成孤儿——前台子进程、`cmd /c`、再 spawn 的 node、`Start-Process`、`Start-Job` 五种启动方式全部实测到【实测】。适配器因此在发出取消**之前**（进程树还完整时）用 PowerShell 的 CIM 读进程表，给 dsh 的后代拍快照（只在有工具在跑时做，预算 9 秒，超时就不等并留诊断），运行结束后只结束快照里仍然存活、父进程已经不在的进程（按进程号加创建时间核对，不会误伤新进程）；以上是 Windows 上的做法（Linux 与 macOS 的实现与未验证事项见本节倒数第二条）。端到端五种启动方式全部通过：运行以已取消收尾、工具记为已取消、孤儿被清掉（`dsh.orphans_stopped` 诊断）、无关的后台进程幸存、同一个会话还能继续；从点取消到“已取消”实测 0.8–4.6 秒（最后一次完整运行是 3.8 秒四次、0.8 秒一次，时间花在取消前读进程表上），孤儿在那之后约 1.6–2.1 秒内被清掉【实测】。
- 关闭：真实 dsh 在标准输入关闭后会自己退出（有工具在跑时约 3.2 秒），但把工具的子进程留下【实测】，所以运行中关闭走 `taskkill /T /F` 结束整棵树（Linux 与 macOS 走 `killTree` 的冻结收敛，已实现、未验证）。这条是真实 dsh 的端到端测试里才暴露的：管理器的关闭与中止信号会并发调用 `close()`，第二次调用越过“结束整棵树”直接关了标准输入，dsh 先退出，`taskkill` 再也找不到它的后代，工具的 `ping` 就被留下了；修法是所有调用方共用同一次关闭，并补了回归测试（假 dsh 提供“标准输入结束就退出”的开关）与变异检查（还原旧逻辑会变红）。修后真实验证：运行中关闭约 0.4–0.5 秒，dsh 与 `ping` 都不在了【实测】。
- 继续与恢复：同一个会话的第二轮上下文保留；新进程里用 `session/resume` 恢复同一个原生会话——历史、模型、推理档位都在，模型端收到的历史里有第一轮的话【实测】，`canResume = true` 以此为据。会话由 dsh 自己每轮落盘（`$DSH_HOME/sessions`，另有 `storages/session_projcache` 的索引）。
- 模型与档位：目录由 dsh 自己给（`session/new` 返回的 `configOptions`，逐个模型切换后读出各自的档位）；默认配置下只有 `deepseek-official/deepseek-v4-flash`，档位 off / low / high / max（默认 high）；挂上假模型补丁后是 `fake/fake-model`（无档位）与 `fake/fake-reasoner`（off / low / high）。先 `set_config_option model` 再 `reasoning_effort`（切换模型后档位会回到该模型的默认值）；指定不存在的模型明说 `model_not_found` 并列出可用的，不悄悄换成默认模型。端到端：选定的模型与档位出现在会话元数据里，假模型端收到的请求里也是这个模型与档位【实测】。
- 探测与首次使用：探测起一个临时的 acp 进程，用 dsh 自己的 `--patch`（层文件格式同 `$DSH_HOME/profiles/acp/cordis.patch.yml`）把 `session-persistence-jsonl` 与 `storage-json` 两处的 root 都改到临时目录，探测完整个目录删除；两处缺一不可——只改会话存储时，索引仍会写进用户的 `~/.dsh`。实测探测之后 `DSH_HOME` 里没有会话与索引，只有 dsh 自己建的 `.anonymous-user-id`（我没有读它，也没有核对它的用途）与 `profiles`；探测耗时 11.9 秒（profile 已初始化时），测到过一次 18.4 秒【实测】。dsh 第一次使用 acp profile 会在 `$DSH_HOME/profiles/acp` 做一次性初始化，通常 5–8 秒，电脑刚重启后的冷启动到过 28 秒；初始化完之后，e2e 里一次最简单的运行（含启动 dsh、设置模型与档位）总共约 8 秒，其中到第一条更新约 4 秒【实测，假模型端点的响应是即时的，真实模型会更慢】。
- 错误形态：401 立即回给 `session/prompt`；429 / 5xx 约 15 秒重试后失败【实测，用假端点造出，429 / 5xx 只在直连 ACP 时看过】。dsh 把一轮的失败写成 `-32603 Internal error: turn failed: <状态>: <正文>`，适配器去掉两层包装并分类：401 记为 `auth_failed` 且运行是 failed、投递停在 `handed_off` 而不是 `applied`；没配凭据时 dsh 自己的原文是 `llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment`，同样归为 `auth_failed`（这段文字取自真实 dsh，分类有单元测试）【实测】。
- 嵌套委派环境：`ENSEMBLE_PARENT_SESSION` 与 `ENSEMBLE_PARENT_DEPTH` 写进 dsh 进程的环境，会话里的 `pwsh` 工具读到了 `SESSION=<id> DEPTH=0`【实测】；dsh 自己启动的 MCP 进程是否继承没有核对。
- Windows：中文与带空格的工作目录、`windowsHide`、整棵进程树清理、结束后没有残留的 dsh 或工具进程【实测】。测试中 dsh 自己在 `%TEMP%` 里留下过小目录：`dsh-acl-skill-*`（约 52 KB，里面是一份 Windows 沙箱 ACL 诊断技能）、`dsh-subprocess-*` 与 `dsh-spill-*`（都是空的，只跑一次探测也会冒出一个 `dsh-spill-*`），另有共用的 `dsh-acl-locks`。这是 dsh 自己的行为，Ensemble 没有清理它们，也没有重定向 `TEMP`（那会改变会话里命令看到的环境）；各自在什么条件下出现没有逐一核对【实测】。
- 品牌标（2026-11-16）：DSH 没有单独的图形，用 dsh web 应用自己的 favicon（`deepseek-ai/deepseek-harness` 仓库 `apps/web/public/favicon.svg`，浅色版，3,634 字节）原样放进来；它是 DeepSeek 的鲸鱼标，仓库是 MIT 许可，同仓库的 `BRAND_GUIDELINES.md` 允许如实描述与 DeepSeek Harness 的关系、建议用“DSH”命名、要求不要造成官方背书的误解——界面上写的是“DSH”，并声明 DeepSeek 不为 Ensemble 背书。Chrome 在 2400×2400 画布上实测可见包围盒 0.9668 × 0.7263，与按三次贝塞尔极值算出的数字一致（`HarnessMark.test.tsx` 会从文件重算）；24 方格里占满（reach = 1，已是上限）可见面积约 218 px²，是各枚里最轻的（其余 243–338 px²，用同一方法）【实测，出处与条款见 `src/web/marks/README.md`】。
- 隔离服务走一遍（2026-11-16）：在隔离的 `ENSEMBLE_HOME`、端口 0 上起真实的服务（另外五个执行端换成模拟器，DSH 是真的；真实的 dsh 0.2.2-rc.1 加脚本化假模型），再让 stdio 的 MCP 桥（干净环境，认不出宿主，不会去读任何宿主的会话）依次走 `harnesses → delegate → wait → read → status → send → cancel`，30 项全部通过：HTTP 里 DSH 是 ready、能力全标 live（steer 为 no、followUp 为 after_run）；`harnesses` 工具列出模型、档位与“no steer mid-run”；Full Access 委派写出了文件并带出“改了 1 个文件”；空闲时 `send` 在同一个会话里开出新一轮；运行中 `send` 答的是“已排队”，补充的文字在第二轮到达了模型；只读委派下写入被沙箱拒绝、文件没有生成、没有任何等待授权的状态；`cancel` 后工具留下的 `ping` 被清掉并留下诊断，会话还能继续；`cancel` 加 `stop` 之后该会话的 dsh 进程结束；服务关闭后没有任何残留的 dsh 或 `ping`【实测】。这一遍还发现 MCP 文字把 `dsh` 拼成“Dsh”（`harnessLabel` 只是把 id 首字母大写），已改成“DSH”并补了测试。
- Linux 与 macOS 上的孤儿清理与“结束整棵进程树”（2026-11-22 加）：**已实现，没有在真实系统上验证过，这批测试编写时也没有运行过**【读码 + 测试（假 `/proc`、注入的 `ps` 样例输出、模拟的进程世界、只在 Linux / macOS 上跑的真实进程树），均未运行】。缘由：上面的取消清理在 Windows 上验证过，但其它系统原先是空的——`defaultProcessTools()` 只在 win32 有值，POSIX 的 `killTree` 只对一个进程发 SIGTERM、等 1.5 秒再 SIGKILL，不动它的后代。做法与取舍：(1) 进程表（`process-list.ts`）：Linux 读 `/proc`（`/proc/stat` 的 btime 加每个进程 `stat` 的 starttime，comm 以第一个“(”与最后一个“)”为界；时钟滴答固定当 100，没有在每种架构上核对；不用 `ps`，最小的容器里没有可用的 `ps` 也行），macOS 跑 `/bin/ps -axww -o pid=,ppid=,stat=,lstart=,comm=`（`LC_ALL=C`），它的格式假设逐条是：每进程一行；`=` 清空列头；pid、ppid 是十进制；状态串首字符是状态字母，Z 是僵尸；`lstart` 恰好五个词（`Sat Nov 21 14:03:05 2026`）、英文三字母月份、日期空格补位（个位数前有两个空格）、本地时间、精确到秒并向下取整；`comm` 在最后一列、可以含空格，名字取最后一个 `/` 之后的部分。(2) 僵尸与已退出的进程排除在表外：不把它们当成“还活着的孤儿”，也不算进“已结束 n 个”。(3) 同一个进程的身份是“进程号 + 原始起始标记”（Linux 是 starttime 滴答，macOS 是 `lstart` 数字化后的文本），不用换算出来的墙钟时间：Linux 的墙钟创建时间依赖 btime，系统校时跳变后同一个进程两次读出的值会不同，活着的父进程会被认成已死，进而误杀它还活着的子进程。墙钟创建时间只和“最早一个进行中的工具调用”比较，并取“最晚可能的时刻”（Linux 加 btime 取整与滴答取整的最大误差，macOS 加 999 毫秒），所以候选只会多不会少，多出来的由“快照里的父进程已经不在”这一条再筛；时钟被往回拨时可能漏掉候选，不会误杀。(4) 自检：读出的表里必须有当前进程自己、它的 ppid 要等于 `process.ppid`，否则整份表作废（`/proc` 不是自己所在的 PID 命名空间、`ps` 输出格式对不上、被沙箱遮住都会这样）；某个 `/proc/<pid>/stat` 除“进程刚好退出”之外读失败（权限、文件句柄用尽……）也让整份表失败，因为读漏的父进程会让它还活着的子进程被当成孤儿。(5) 判断孤儿不看这个进程现在的 ppid（POSIX 上孤儿会被 init 或 subreaper 收养、ppid 变成 1），看快照里记的父进程现在还在不在，Windows 与 POSIX 都成立。(6) 结束整棵树（`process-kill.ts`）：读表沿 ppid 找出目标的全部后代，先对它们发 SIGSTOP 冻结，再读一遍表把新出现的后代也冻结，直到一轮里没有新进程且已冻结的都显示为停止（最多 6 轮、冻结阶段总共不超过 3 秒），然后统一发 SIGKILL，再用 `kill(pid, 0)` 加进程表确认它们消失（僵尸不算活着）。冻结是为了堵“读表之后、发信号之前又 fork”的竞态：按 POSIX 的约定，停止的进程不能再 fork，SIGKILL 对它照样生效，它也不会自己退出、进程号不会被复用（没有在每个系统上核对）；超过上限说明这棵树 fork 得比冻结还快，不再追，带着已知的进程结束并标出没有收敛；冻结期间无论怎么出错，已冻结的进程都会被结束（杀不掉的发 SIGCONT 恢复），绝不留在停止状态。(7) 安全（宁可漏掉也不误杀）：只对读表时看到的进程发信号，每一轮重新核对身份；不对进程号 ≤ 1、自己、自己的祖先发信号，目标是这些时整个拒绝；没有“当初看到的样子”时目标必须是自己的后代，清理孤儿时它早已被系统收养，由快照里的样子证明身份；读不了表（以及没有读表实现的系统）时，带身份凭据的一律不动，没有的退回只对这一个进程发信号并如实标出没有处理后代；ESRCH 吞掉，EPERM 等记为失败，`killTree` 永不抛错。(8) 取消路径与 dsh 的运行中关闭强制：不先发 SIGTERM，与 Windows 的 `taskkill /F` 对齐；只有执行端进程自己的关闭（`spawnJsonl.kill`，已经先关了标准输入、等过 0.9 秒）保留一步最多 1.5 秒的 SIGTERM。(9) 没有改变 spawn 的方式、没有让执行端自成进程组：`kill(-pgid)` 可以一次结束整组、没有 fork 竞态，但会改变 Ctrl+C 与服务崩溃时的行为，逃出进程组的守护进程照样漏掉，留给用户决定。(10) 其它系统（BSD、Solaris、AIX 等）：`defaultProcessTools` 返回空，不清理；`killTree` 读不了表，退回只对这一个进程发信号。Windows 的代码路径（`listWindowsProcesses`、`parseProcessList`、`taskkill /T /F` 与它的调用方式和时序）没有改动。
- 提问（2026-11-22 只读调查，没有运行 dsh；**没有实现转交**）：在本机全局安装的 `@deepseek-ai/dsh` 0.2.2-rc.1 自己的文件里（不含 `node_modules`）搜不到提问相关的字样（`elicit`、`ask_user`、`request_user_input`、`AskUserQuestion`）；它依赖的 `@agentclientprotocol/sdk` 的协议定义里有 elicitation 类型，但没有看到 dsh 使用它。适配器对 `session/request_permission` 之外的服务端请求一律回 `-32601` 并记 `dsh.unsupported_request`。没有观察到 dsh 发出过提问请求，所以“它没有提问通道”也只是“没有发现”，不是已证实【读本机安装的包文本；只搜了字样，没有读完打包后的代码】。
- 没有验证的：真实的 DeepSeek 模型运行（本机没有 DeepSeek 凭据——模型输出的质量、真实模型下第一次响应的耗时、用量口径都没有核对）；真实的 429 / 5xx 重试表现（只在直连 ACP 时用假端点看到过）；用用户自己的 `~/.dsh` 配置（插件、MCP 服务）运行；`delivery:"queue"`；在官方声明的 Node ≥ 24.9.0 下运行（只在 Node 22.22.2 上验证，Node 24 下的行为没有跑过 Ensemble 的路径）；Linux 与 macOS（整个适配器都没有在这两个系统上跑过；取消后的孤儿清理与“结束整棵进程树”已实现但没有验证，具体没有验证的有：dsh 与 OpenCode 在这两个系统上取消时是否同样只杀工具的 shell 那一层、会不会真的留下孤儿；Linux 上读 `/proc` 与 macOS 上解析 `ps` 输出在真实系统上的表现，尤其是 macOS 的列格式、日期格式与时区；冻结后统一结束整棵树的办法在真实的工具进程树（构建、测试这类大量 fork 的）下的耗时与是否漏网；OpenCode 的 shell 根进程是否一定是服务进程的后代；没有会回收孤儿的 init 的容器里僵尸进程的处理；这批测试本身没有运行过）。
