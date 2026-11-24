> **2026-11-22 补注（正文没有改动）：** 本文是 2026-11-16 的记录，写的是当时的代码。此后 `src/` 里的相关代码已有改动，文中引用的行号与规模都已对不上现在的文件，请按函数与内容去找，不要按行号：文中的 `workspace()` 与 `callContext()` 现在是 `src/mcp/call-context.ts` 里 `CallContext` 的 `workspace()` 与 `forCall()`，`callContext()` 也不再自己用 `roots?.[0] ?? options.cwd` 定来源的工作区；`delegate` 的 `cwd` 决议与“插件安装目录”那道保护，现在在 `src/mcp/delegate-request.ts` 的 `chooseDirectory`；`src/mcp/origin.ts` 里写入 `origin.workspace` 的位置，和 `src/web/scene/layout.ts` 里按来源归并 Folder 的 `workspaceOf`（文中写“约 265 行”），也都移动了。这段补注只更新“去哪里找”，不表示下面记录的问题已经解决，也不表示运行中的服务与已安装的插件副本带上了这些改动。补一句（同样只更新“去哪里找”）：上面说的按来源归并 Folder 的 `workspaceOf`，现在是 `src/web/scene/layout-workspace.ts` 里 `indexWorkspaces` 函数内部的那份映射；`src/web/scene/layout.ts` 已拆成 `layout-*.ts` 的几个模块，自己只剩入口与再导出，这同样不表示文中的问题已经解决。

# Cursor IDE 宿主下的两个 Ensemble 问题（工作区目录与来源归并）

- 日期：2026-11-16
- 发现场景：在 Cursor IDE 里（宿主 `cursor-vscode`）用 Ensemble 委派 5 个 Cursor 会话，在 `C:\Users\<user>\Desktop\<project>` 并行开发。
- 环境：Windows 11（10.0.26200）、Ensemble 当时的提交 `722de65`（公开仓库是重新开始的历史，里面没有这个提交）、已安装插件目录 `C:\Users\<user>\.cursor\plugins\local\ensemble`（是目录副本，不是链接）。
- 本文只记录问题、证据和建议，**没有修改任何代码**。证据标注沿用 `docs/findings.md` 的约定：【实测】在这台机器上对真实软件运行得到；【读码】阅读源码得到；【推断】由证据推出，没有被直接验证。

## 摘要

1. **面板里 Folder 节点显示 `C:\Users\<user>`，不是项目目录。** 会话实际工作的目录是对的（每次委派都显式传了 `cwd`），错的是 Main Agent（来源）自带的工作区 `origin.workspace`。原因是 Cursor 对 `roots/list` 的返回被 MCP SDK 的严格校验拒绝，桥退回到自己的进程目录（用户主目录）。【实测】【读码】
2. **这个回退还带来一个隐患：`delegate` 漏传 `cwd` 时，会话会静默在用户主目录里以 Full Access 工作。** 现有保护只拦截"插件安装目录"。【读码】
3. **同一个 Main Agent 在面板上会被拆成多张来源卡。** Cursor IDE 宿主不提供对话标识，来源 key 退化成"桥进程编号"，桥一重启就换。【实测】
4. 另有一个未查明的现象：MCP `wait` 偶发 `Connection closed`，之后桥进程换了编号。原因没有排查。

## 问题 1：Folder 节点显示用户主目录

### 现象

画布上 Folder 节点写着 `<user>` / `C:\Users`，悬停提示为：

```text
Working directory
Directory: C:\Users\<user>
Used by 2 Main Agents
```

预期应是项目目录 `C:\Users\<user>\Desktop\<project>`。

### 证据

【实测】读取 5 个会话各自的 `data\sessions\<id>\events.jsonl` 中 `session.created` 的 `meta`：

| 会话 | `meta.cwd`（会话实际工作目录） | `origin.workspace`（Folder 节点来源） | `origin.key` |
|---|---|---|---|
| `ses_01m7hjxb6ax3hqvtcfgxk1zjwk` | `C:\Users\<user>\Desktop\<project>` | `C:\Users\<user>` | `cursor:bridge-7fe24e69` |
| `ses_01m7hkekdgv81ehz4rmckf5bck` | `C:\Users\<user>\Desktop\<project>` | `C:\Users\<user>` | `cursor:bridge-70b49d0d` |
| `ses_01m7hkpqcx7h6jpskwy9wae1zv` | `C:\Users\<user>\Desktop\<project>` | `C:\Users\<user>` | `cursor:bridge-70b49d0d` |
| `ses_01m7hm2vrqx6a4xxrbvbz3afx8` | `C:\Users\<user>\Desktop\<project>` | `C:\Users\<user>` | `cursor:bridge-70b49d0d` |
| `ses_01m7hmet4m5vbd889rym0257ev` | `C:\Users\<user>\Desktop\<project>` | `C:\Users\<user>` | `cursor:bridge-70b49d0d` |

每次 `delegate` 的回执都写着 `workspace source: argument`。

【实测】`%LOCALAPPDATA%\Ensemble\logs\mcp-bridge.log` 在每个新桥的第一次 `delegate` 时都有：

```text
roots unavailable
  roots[0].uri / roots[1].uri / roots[2].uri:
  Invalid string: must start with "file://"   （code: invalid_format, format: starts_with）
```

含义：宿主**声明了** `roots` 能力，也返回了 **3 个**根，但 3 个 `uri` 都不以 `file://` 开头，被 SDK 的响应校验拒绝。具体是什么形态（裸 Windows 路径、`file:/c:/…`，还是别的）这份日志没有记录，**未知**。

### 根因链【读码】

1. `src/mcp/bridge.ts` 的 `workspace()`（约 154–177 行）调用 SDK 的 `server.listRoots()`；校验失败抛错，被 `catch` 记成 `roots unavailable`，`this.roots` 保持 `null`。
2. `callContext()`（约 180–190 行）取 `const workspace = this.roots?.[0] ?? this.options.cwd`，把它交给 `detectOrigin()`，写入 `origin.workspace`（`src/mcp/origin.ts` 约 189 行）。
3. `this.options.cwd` 来自 `src/cli/main.ts` 约 134 行的 `cwd: process.cwd()`，即 Cursor 启动桥进程时的工作目录，这里是用户主目录 `C:\Users\<user>`。
4. 画布布局 `src/web/scene/layout.ts` 约 265 行：`if (summary.origin.workspace) workspaceOf.set(summary.origin.key, summary.origin.workspace)`，Folder 节点只看 `origin.workspace`，因此两张来源卡被归到同一个 Folder `C:\Users\<user>`，写着"2 Main Agents"。

### 影响

- **显示层**：Folder 节点指向错误目录；依赖 `origin.workspace` 的功能（如画布上按工作树归属的 Git 信息）可能也会取到错误目录【推断，未逐项验证】。
- **行为层（隐患）**：`delegate` 里 `cwd = args.cwd ?? roots?.path ?? fallback`（`bridge.ts` 约 322 行），`fallback` 就是桥进程目录。现有保护（约 316 行）只在 `fallback` 是**插件安装目录**时才拒绝。所以漏传 `cwd` 时，会话会在 `C:\Users\<user>` 里工作，权限是 Full Access，且回执里只会写一行 `workspace source: the bridge process directory`，不够醒目。【读码】
- 本次 5 个会话**不受影响**，因为每次都显式传了 `cwd`。

### 当前规避

- 每次 `delegate` 都显式传 `cwd`。这是目前唯一可靠的办法。
- 面板上的 Folder 显示无法靠使用习惯修正。

### 建议修复（本次未执行）

1. **宽松解析 roots。** 不用 SDK 严格的 `listRoots()`，改发原始 `roots/list` 请求并用宽松结构接收（`uri` 当普通字符串）。归一化时兼容 `file://`、`file:/c:/…`、裸 Windows 路径，其余忽略。**第一步先把 Cursor 实际返回的 3 个 `uri` 形态记进日志**，再据此写解析；不要凭猜测定格式。
2. **不要盲取 `roots[0]`。** Cursor 返回了 3 个根，哪个是项目目录未知。即使解析成功，多根工作区里 `roots[0]` 也可能不是当前项目。可行做法：面板里展示全部根，或在 `delegate` 的 `cwd` 落在某个根之下时用该根作为来源工作区。【推断】
3. **不展示误导性的目录。** 拿不到 roots 时，如果回退目录是用户主目录或盘符根目录，就不要把它当 `origin.workspace`，Folder 节点留空比显示 `C:\Users\<user>` 更诚实。
4. **扩大 `delegate` 的保护。** 在现有"插件安装目录"检查旁，对"用户主目录 / 盘符根目录"同样要求显式 `cwd`，并把"会话将在桥进程目录工作"这件事在回执里写得更醒目。
5. **测试**：覆盖多种 `uri` 形态、多根选择、主目录保护、Folder 显示。

### 生效前提

- 重建 `dist`，并把更新带到已安装插件目录。该目录不是链接（`LinkType` 为空），不会自动跟随仓库更新；具体怎么同步需要修复时先确认。
- 在 Cursor 里重启 Ensemble 的 MCP 或重载窗口。重启会让桥换新编号，面板上会多一张来源卡（见问题 2）。

## 问题 2：同一个 Main Agent 被拆成多张来源卡

### 现象

同一个对话派发的会话，在面板上分属两张 Main Agent 卡：

- `cursor:bridge-7fe24e69`：白底会话（15:07 创建）。
- `cursor:bridge-70b49d0d`：之后的 4 个会话（15:16 起）。

### 证据

【实测】`logs\origin-debug.jsonl` 里，早先用 `cursor-agent-script` 宿主时，来源 key 是稳定的 `cursor:299997f3-…`，证据为 `env:CURSOR_CONVERSATION_ID`。换成 IDE 宿主 `cursor-vscode` 后，`clues` 里只有 `clientInfo` 和一个 `progressToken`，环境变量里**没有** `CURSOR_CONVERSATION_ID`，检测结果变成 `cursor:bridge-7fe24e69`，随后桥重启后变成 `cursor:bridge-70b49d0d`，证据只有 `clientInfo:cursor-vscode`。

### 根因【读码】

`src/mcp/origin.ts` 在宿主不提供会话标识时，用桥进程自己的随机编号 `bridgeId` 兜底（"一个桥进程 = 一个发起端"）。桥进程一重启（例如 Cursor 重载 MCP），编号就变，同一个对话就成了另一个来源。

### 影响

- `status` / `wait` 默认只看当前来源派发的会话，换桥后默认看不到旧会话。
- 用户在面板里对旧会话的介入，只会通知旧来源，新桥上的 Agent 可能收不到。
- 面板上每重启一次多一张来源卡。

### 当前规避

- 调用 `wait` / `read` 时显式传会话 ID，`status` 用 `scope: "all"`。

### 建议（本次未执行）

- 让 `delegate` 可显式声明稳定的来源标识（由调用方传入当前对话 ID），或让 Ensemble 提供合并来源的接口（目前只有 `POST /api/sessions/<id>/parent` 可以重新指定承接关系，没有合并来源的接口）。
- 或者用 Cursor 窗口而不是桥进程作为兜底键。后者会把同一窗口的多个对话合并成一个来源，取舍需要决定。

## 问题 3（未查明）：`wait` 偶发 `Connection closed`

- 现象：一次 MCP `wait` 返回 `Connection closed`，Ensemble 服务本身仍在运行（CLI `status` 显示 `running 1`），重试成功；随后桥进程编号变了，即桥被重启过。
- 未排查：是桥进程自己退出，还是 Cursor 重载了 MCP。`bridge.ts` 末尾 `process.stdin.on("close", () => process.exit(0))` 表明宿主关闭管道桥就会退出，所以更像是宿主侧关闭了管道，但这只是【推断】。

## 还没有验证的事项

1. Cursor 对 `roots/list` 实际返回的 3 个 `uri` 的形态，以及它们各自指向哪个目录。
2. 画布上其他依赖 `origin.workspace` 的功能（Git 归属等）是否也受影响。
3. 问题 3 的真实原因。
4. `docs/findings.md` 里对 Cursor 的结论是【读码】，没有在 Cursor 里真正加载并调用过。本次是第一次真实运行，上面第 1、2 个问题的观察可以作为补充，需要时回写进 `docs/findings.md` 的 Cursor 一节。

## 相关位置

| 位置 | 内容 |
|---|---|
| `src/mcp/bridge.ts` 约 154–177 行 | `workspace()`，`listRoots()` 与失败处理 |
| `src/mcp/bridge.ts` 约 180–190 行 | `callContext()`，`roots?.[0] ?? options.cwd` |
| `src/mcp/bridge.ts` 约 314–323 行 | `delegate` 的 `cwd` 决议与现有保护 |
| `src/mcp/workspace.ts` | `isPluginInstallDirectory` |
| `src/mcp/origin.ts` 约 189 行 | 写入 `origin.workspace`；`bridgeId` 兜底 |
| `src/cli/main.ts` 约 134 行 | `cwd: process.cwd()` |
| `src/web/scene/layout.ts` 约 265 行 | Folder 节点只取 `origin.workspace` |
| `%LOCALAPPDATA%\Ensemble\logs\mcp-bridge.log` | `roots unavailable` 记录 |
| `%LOCALAPPDATA%\Ensemble\logs\origin-debug.jsonl` | 来源检测线索 |
| `%LOCALAPPDATA%\Ensemble\data\sessions\<id>\events.jsonl` | 会话的 `cwd` 与 `origin` |
