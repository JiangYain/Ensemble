# vendor/mosoo-agent-driver

这是 Mosoo `agent-driver` 的**本地副本**，加上我们自己新增的 **Cursor SDK 后端**。Ensemble 通过别名 `@mosoo/agent-driver` 直接编译、打包这份源码，用它驱动被委派的 Cursor 会话。

## 来源

| 项 | 内容 |
| --- | --- |
| 上游仓库 | <https://github.com/langgenius/mosoo-agent-driver> |
| 锁定提交 | `49df36e9735f261829ea90b6570382bd33a67775`（由 mosoo 主仓库提交 `465d9f26ec8e8d48d4bd02e61034cf3e7139c5b9` 引用） |
| 上游包名 / 版本 | `@mosoo/agent-driver` 0.1.0（见 `package.upstream.json`；上游 `package.json` 原样保留，没有被当作本仓库的依赖声明） |
| 许可证 | Apache-2.0，全文见 `LICENSE.txt`；归属说明见仓库根目录 `NOTICE` |
| 取得方式 | `git clone` 后检出上述提交，按下文“拷贝范围”裁剪；基线哈希记录在 `UPSTREAM-MANIFEST.json` |

做成本地副本而不是 npm 依赖，是 2026-11-08 的明确决定：把 Cursor SDK 整合成 Mosoo driver 的一部分，用它来驱动 Ensemble。上游 Driver 目前只有 Codex app-server、Claude Agent SDK、ACP、Pi 四类后端，没有 Cursor SDK；Cursor 必须作为 Driver 的一个后端存在，而不是在宿主侧另写一套适配。

## 拷贝范围

拷贝了（`src/` 下，除下面列出的修改外与上游逐字一致）：

- `contract`、`core`（Driver Kernel、命令分发、终态纪律、事件队列）、`host-ports`、`observability`、`protocol`、`runtime-command`、`skill-package`、`utils`；
- `runtimes/` 的根部辅助文件，以及 `runtimes/mcp`、`runtimes/openai`、`runtimes/pi`；
- 根部的 `boot.ts`、`events.ts`、`orpc.ts`、`paths.ts`、`provider-output.ts`、`runtime-events.ts`、`runtime.ts`、`index.ts`；
- `LICENSE.txt`、`README.md`（存为 `UPSTREAM-README.md`）、`package.json`（存为 `package.upstream.json`）。

没有拷贝：

- `src/bin`、`src/boot`、`src/infrastructure`、`src/projections`、`src/stores`、`src/surfaces`、`src/runtime-events`、`src/cma-http.ts`、`src/cma-sdk.ts`：Driver 作为独立进程、Managed-Agents HTTP 适配和云端存储的部分，与“进程内嵌入 Kernel”无关；
- `src/runtimes/acp`、`src/runtimes/claude`：ACP 与 Claude 后端，Ensemble 不使用，且 ACP 默认后端 OpenCode 并不等于 Cursor；
- `tests`、`bench`、`scripts`、`assets`、`.github`、`Containerfile`、`bun.lock` 与镜像构建文件。

`runtimes/openai` 与 `runtimes/pi` 目录保留是为了和上游逐字对照、方便以后升级，但**没有登记到** `provider-registry.ts`，运行时不可达，也没有被验证过。它们和 Kernel 之外的若干文件（`child-process.ts`、`atomic-file.ts`、`native-checkpoint.ts`、`openai/auth-state.ts`）带有 Linux `/proc`、POSIX 路径与 Bun 的假设，在 Windows 上没有验证，也不应被声明为可用。

## 修改清单

下面每个文件在源码顶部都有 `ENSEMBLE MODIFIED` 或 `ENSEMBLE ADDED` 注释（Apache-2.0 第 4(b) 条：修改过的文件须带有醒目的修改说明）。`node scripts/vendor-status.mjs` 会对照基线检查，清单与实际差异不一致就失败。

修改的上游文件：

- `src/index.ts`：删除对 `projections`、`surfaces`、`stores` 的导出（这些目录没有拷贝）；新增 `export * from "./runtimes/cursor"`。
- `src/protocol/runtime.ts`：在 `SUPPORTED_DRIVER_RUNTIMES`、`SUPPORTED_DRIVER_RUNTIME_TRANSPORTS`、`SUPPORTED_DRIVER_NATIVE_RUNTIME_REF_KINDS` 中新增 `cursor`、`cursor-sdk`、`cursor_agent_id`，并让 `getExpectedDriverNativeRuntimeRefKind("cursor")` 返回 `cursor_agent_id`。
- `src/protocol/boot/index.ts`：运行时到传输的映射里新增 `cursor: "cursor-sdk"`。
- `src/runtimes/provider-registry.ts`：重写，只登记 `cursor-sdk` 一个后端（运行时 `cursor`），并如实声明它的能力：不支持 custom tool / MCP 执行 / 权限请求（Cursor 会话是 Full Access，没有需要人批准的闸门）；支持文件变更、运行中输入、会话停止、文本与工具流式、取消、用量、思考流、原生恢复。会话启动时拒绝：未知传输、运行时与传输不匹配、被禁用的内置工具、`additionalDirectories`（Cursor 本地 Agent 只有一个工作目录）。

新增的文件（全部在 `src/runtimes/cursor/`）：

- `src/runtimes/cursor/cursor-driver-backend.ts`：`CursorDriverBackend`，实现 `AgentDriverBackend`：启动 / 恢复 Cursor Agent、发送输入、消费消息流、取消（`cancelActiveTurn` 在内核的 2 秒宽限内返回）、关闭；终态纪律（`run.completed` 附 checkpoint、`run.cancelled`、`run.failed` 且 `recoverable === retryable`）；另有一个 Driver 协议里没有的扩展方法 `steer()`，真实反映 `Run.steer()` 的三种结果；以及 `usable`（取消之后原生运行迟迟不收尾、被放弃的实例不可再用，宿主据此换新 Kernel）和可注入的 `cancelSettleMs`（测试用，默认 5 秒）。
- `src/runtimes/cursor/cursor-event-translator.ts`：把 Cursor SDK 的消息流翻译成 Driver 统一事件（文本与思考增量、工具调用、文件变更、计划、用量、模型路由与诊断），并以 `RunResult` 校正流式增量；判定终态与错误码。
- `src/runtimes/cursor/cursor-configuration.ts`：从 `DriverStartInput.execution` 读取后端配置（模型、`CURSOR_API_KEY`、`providerOptions` 中的 `modelParams` / `settingSources` / `readOnly` / `agentName` / `modelHint`），生成 `Agent.create / resume` 的参数。
- `src/runtimes/cursor/cursor-errors.ts`：把 SDK 的类型化错误归类成稳定的错误码（认证、限流、模型不存在、上下文溢出、网络……）与是否可重试。
- `src/runtimes/cursor/cursor-sdk.ts`：`@cursor/sdk` 的最小结构类型与运行时懒加载；SDK 作为可选的运行时依赖，没有它时 Kernel 与其余代码照常加载。默认加载器和 `asCursorSdkAgentApi` 用 `isSdkExport` 校验导出：真实 SDK 的 `Agent` 是带静态方法的类（函数），不是普通对象；只认对象会把真实安装的 SDK 拒之门外（用真实 SDK 跑加载测试时发现并修复，回归测试在 `src/server/executors/cursor-sdk-loader.test.ts`）。
- `src/runtimes/cursor/cursor-tool-format.ts`：Cursor 工具名、参数与结果的展示与分类（读 / 改 / 删、命令、MCP、计划）。
- `src/runtimes/cursor/cursor-values.ts`：无依赖的小工具（取字段、截断、安全序列化）。
- `src/runtimes/cursor/index.ts`：对外导出。宿主（`src/server/executors/`）直接复用其中的 `CURSOR_SETTING_SOURCES`（`settingSources` 的合法取值，宿主解析环境变量时与后端校验同源）、`cursorFailure`（SDK 错误归类，即 `cursor-errors.ts` 的 `sdkFailure`）和 `asCursorSdkAgentApi`（SDK 模块的唯一一处导出校验），而不在宿主侧另抄一份。

## 已核对与未核对

已核对（有测试；运行环境 Windows 11 + Node 22.22.2，Kernel 与后端都是真实代码，只有 Cursor SDK 是假的）：

- `src/server/driver/cursor-backend.test.ts`（Kernel + 后端，不经过 Ensemble 的管理器）：Kernel 加载、启动并收发命令；启动时发出 `runtime.resume.updated`；一次完整运行的事件顺序与 `run.completed` 的 checkpoint；后端产出的全部事件（文本、思考、工具、文件变更、计划、用量）都能通过上游的 `ingestRuntimeEventInput`（内部即 `parseRuntimeEventEnvelope`）校验；`turn.cancel` 后运行以 `run.cancelled` 收场、Kernel 继续接下一次输入；取消放弃路径（SDK 的 `cancel()` 返回但流不收尾）里，宿主看到 `run.cancelled` 时后端已经 `usable === false`；运行失败时 `run.failed` 先于命令被拒绝、Kernel 失败并关闭 Agent；SDK 拒绝运行时不发 `run.started`；`stop` 取消在途运行、关闭 Agent 并结束事件流；用 Agent id 恢复、只在第一次发送时 `force`；Agent 不存在时的 `session_not_resumable`；只读会话的工具白名单。
- `src/server/driver/cursor-driver-session.test.ts`（Ensemble 的 `CursorDriverSession`）：运行失败后换新 Kernel、先关旧 Agent 再 `Agent.resume` 同一个 id；启动失败变成可行动的 `HarnessStartError` 且会话可继续使用；放弃取消后下一次运行重新接入；普通取消不换 Kernel；空闲关闭很快返回；运行中关闭后不再发事件；超过命令大小上限的消息被拒绝；没有任何 `permission.*` 事件。
- `src/server/executors/cursor*.test.ts`（经由管理器；原先针对 Ensemble 自己的 Cursor 适配器，现在全部走 Kernel；共用的假 SDK 与夹具在 `cursor-test-kit.ts`）：`cursor.test.ts`（探测、模型目录与执行端注册表）、`cursor-events.test.ts`（事件映射与错误归类）、`cursor-steer.test.ts`（纠偏三种结局与迟到的结论）、`cursor-lifecycle.test.ts`（取消、关闭、恢复）、`cursor-options.test.ts`（模型目录形状与档位、访问级别、设置来源、凭据不外泄）；`cursor-sdk-loader.test.ts` 另外用真实安装的 `@cursor/sdk` 核对加载器能识别它（其中查询登录状态的用例使用内存凭据库，不读取用户的真实凭据）。

集成中发现并处理的 Kernel 约束（上游没有文档，是跑测试发现的）：

- `session.stop` 需要一个“确切的运行 id”来收束实例。`DriverStartInput.execution.run.runId` 为 `null` 且从没跑过运行时，停止会失败、事件流不会关闭。`buildCursorStartInput` 因此总是给一个永远不会启动的占位 id。
- 运行以 `run.failed` 收场会让 Kernel 整体失败（`input.start` 被拒绝、事件流关闭）。宿主把这当作“换代”信号：等旧 Kernel 关闭 Agent，再新建 Kernel 并用 Agent id 恢复。
- 进程内的会话级事件用 `runId: null` 表示“不属于任何运行”（上游自己的约定）；进入事件信封时要省略 `runId`，否则 `parseRuntimeEventEnvelope` 会拒绝。
- `Promise.try` 在 Node 22 里不存在；上游只在 MCP 执行路径里用它，Ensemble 不走那条路径，宿主仍在 `src/server/driver/runtime-compat.ts` 里补了一个等价实现。

**未核对**：

- 没有经 Ensemble 自己的 SDK 与凭据在真实 Cursor 账号上跑通；SDK 的消息形状依据 `@cursor/sdk` 1.3.1 的类型定义与打包源码，测试里的假 SDK 按同样形状编写。2026-11-08 另经用户自己的 SDK 网关（SDK 1.0.28）做过一次最小的真实运行，事件的顺序与形状与上面的假设一致（其中没有 `system` 消息），已做成回放测试（`src/server/executors/cursor-events.test.ts`）。
- Driver 契约里的 `run.steer` 事件、`parentRunId` 只是协议定义，上游生产命令链并没有实现运行中纠偏与父子委派；Ensemble 的纠偏走上面的 `steer()` 扩展，父子关系由 Ensemble 自己记录。

## 升级上游

1. 在临时目录 `git clone` 上游并检出目标提交，对 `src/` 做和本文“拷贝范围”一致的裁剪；
2. 对比新旧基线：`node scripts/vendor-status.mjs` 列出我们的修改，逐个文件合并上游的变化；
3. 合并完成后更新 `UPSTREAM-MANIFEST.json`（只在“导入或升级上游”的那一次提交里执行 `node scripts/vendor-status.mjs --write`）、本文的锁定提交，以及 `docs/research/mosoo-technical-reference.md` 里的版本说明；
4. 跑全量测试与类型检查，并确认 Windows 上的 Kernel 加载测试仍然通过。
