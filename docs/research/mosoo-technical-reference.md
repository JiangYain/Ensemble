# mosoo 对 Ensemble 的技术借鉴评估

研究日期：2026-11-07（Asia/Shanghai）。本文记录源码与官方说明的研究结果。研究后用户已明确决定将 **`@mosoo/agent-driver` 作为 Ensemble 的依赖项**。依赖版本和具体接入方式仍需在开发时确定；本机兼容性与控制能力仍需验证。研究期间没有安装依赖、运行应用、调用模型或验证跨平台行为。

## 版本与研究范围

- mosoo 主仓库：`465d9f26ec8e8d48d4bd02e61034cf3e7139c5b9`。
- 该主仓库的 `apps/driver` 子模块固定为 mosoo-agent-driver 的 `49df36e9735f261829ea90b6570382bd33a67775`。
- 以下 Driver 结论按上述固定版本引用，不混用 Driver main 后续变化。

来源：[主仓库](https://github.com/langgenius/mosoo/tree/465d9f26ec8e8d48d4bd02e61034cf3e7139c5b9)、[子模块位置](https://github.com/langgenius/mosoo/tree/465d9f26ec8e8d48d4bd02e61034cf3e7139c5b9/apps/driver)。

## 判断

已确定使用 `@mosoo/agent-driver` 作为 Ensemble 的 Harness 执行适配层依赖，重点利用其命令、事件、后端适配与 Host Ports。以下研究事实与能力边界用于指导接入，不再将其列为候选依赖；本机环境与所需控制能力的验证属于后续实施工作。

mosoo 整体定位是面向应用后端的托管 Agent 运行时。它的云沙箱、项目和部署管理，不等于 Ensemble 希望提供的本地 Plugin / MCP 和协作控制台。Ensemble 的任务交接、父子关系、人类纠偏与主 Agent 同步，仍需自行定义。

来源：[mosoo README](https://github.com/langgenius/mosoo/blob/465d9f26ec8e8d48d4bd02e61034cf3e7139c5b9/README.md)、[Driver README：定位与边界](https://github.com/langgenius/mosoo-agent-driver/blob/49df36e9735f261829ea90b6570382bd33a67775/README.md#ai-execution-bridge-architecture)。

## 已核对的实现与边界

### 1. 独立 Driver 是最贴近 Ensemble 的部分

Driver 已提供四类后端：Codex app-server、Claude Agent SDK、ACP、Pi RPC。Provider Registry 把它们投射为统一的命令与事件；声明了文本流、工具流、可见活动、用量、取消和原生恢复等能力。这里核对的是代码与能力声明，没有实际执行兼容性测试。

Registry 中未注册 Cursor SDK 后端。ACP 默认进程是 OpenCode，命令可配置；这不等于已经验证 Cursor 能无缝接入。

来源：[provider-registry.ts，15–61 行](https://github.com/langgenius/mosoo-agent-driver/blob/49df36e9735f261829ea90b6570382bd33a67775/src/runtimes/provider-registry.ts#L15)、[runtime.ts，3–21 行](https://github.com/langgenius/mosoo-agent-driver/blob/49df36e9735f261829ea90b6570382bd33a67775/src/protocol/runtime.ts#L3)、[Driver README](https://github.com/langgenius/mosoo-agent-driver/blob/49df36e9735f261829ea90b6570382bd33a67775/README.md#ai-execution-bridge-architecture)。

### 2. Kernel 与 Host 的责任划分值得参考

Backend 接口包括启动、处理输入、请求取消和停止。Host Ports 将命令来源、事件接收、文件、MCP、权限和 Skill 等能力交给宿主提供。库与生产沙箱启动器分离，因此可以研究如何由 Ensemble 的本地服务实现自己的宿主连接，而不复制完整云平台。

该包公开了多个独立入口，依赖列表没有 `@mosoo/*` 运行时依赖；但它仍有 Bun、原生 CLI 和启动契约等要求，并不是零配置替换当前 CursorSDK 插件。

来源：[agent-driver-backend.ts，66–100、121–134 行](https://github.com/langgenius/mosoo-agent-driver/blob/49df36e9735f261829ea90b6570382bd33a67775/src/core/agent-driver-backend.ts#L66)、[package.json，25–69、98–119 行](https://github.com/langgenius/mosoo-agent-driver/blob/49df36e9735f261829ea90b6570382bd33a67775/package.json#L25)。

### 3. mosoo 产品的忙时输入不等于实时纠偏

产品规格明确排除输入队列与运行中 steering。源码的会话准入条件要求会话处于 IDLE，且不存在活动 Run。函数名和内部状态中的 queued，指的是获准运行后的内部调度状态，不能解释为允许用户给忙碌会话继续排队输入。

生产 Driver wire 的命令集合包括 input.start、turn.cancel、session.stop、mcp.execute、permission.resolve，没有运行中补充输入的 steering 命令。

来源：[SPEC.md](https://github.com/langgenius/mosoo/blob/465d9f26ec8e8d48d4bd02e61034cf3e7139c5b9/docs/SPEC.md)、[session-run-admission.repository.ts，100–169 行](https://github.com/langgenius/mosoo/blob/465d9f26ec8e8d48d4bd02e61034cf3e7139c5b9/apps/api/src/modules/runtime/infrastructure/session-runs/session-run-admission.repository.ts#L100)、[runtime-command/index.ts，35–115 行](https://github.com/langgenius/mosoo-agent-driver/blob/49df36e9735f261829ea90b6570382bd33a67775/src/runtime-command/index.ts#L35)。

### 4. 取消是已有控制路径

mosoo 的 cancelRun 会把取消请求发给对应 Driver，附带 Run 标识与取消原因，再更新状态并写入取消事件。它为 Ensemble 提供了“干预既是控制动作，也是可观察记录”的实现参考。源码核对不代表已经实测取消能够终止所有外部副作用，也不等于回滚文件变更。

来源：[cancel-run.service.ts，47–118 行](https://github.com/langgenius/mosoo/blob/465d9f26ec8e8d48d4bd02e61034cf3e7139c5b9/apps/api/src/modules/runtime/application/session-runs/cancel-run.service.ts#L47)。

### 5. 不能把 standalone contract 当作生产功能

Driver 的独立 contract 模块确实定义了 run.steer，并允许 run.start 携带 parentRunId。这些是有价值的建模参考，但不能据此声称 mosoo 产品已具备运行中插话、跨 Harness 父子委派及人类干预同步。

README 区分了 standalone contract 与生产 oRPC 命令链；实验 CMA-shaped adapter 也明确不属于 mosoo 的生产 API。Ensemble 评估依赖时，应核对“类型里有定义”“Kernel 实际处理”“Host API 对外开放”“UI 能操作”四个层次。

来源：[contract/command.ts，16–99 行](https://github.com/langgenius/mosoo-agent-driver/blob/49df36e9735f261829ea90b6570382bd33a67775/src/contract/command.ts#L16)、[Driver README：Contract Library](https://github.com/langgenius/mosoo-agent-driver/blob/49df36e9735f261829ea90b6570382bd33a67775/README.md#contract-library)、[Driver README：Boundaries](https://github.com/langgenius/mosoo-agent-driver/blob/49df36e9735f261829ea90b6570382bd33a67775/README.md#boundaries)。

### 6. 公共事件 API 的恢复范围有上限

Public Thread API 在持久化事件后再分发，重连重发最近窗口，客户端可按稳定事件 ID 去重。但窗口同时受事件数和字节数限制，而且没有读取更旧事件的 cursor；客户端落后太久会无法补读缺口。这是有界的进度恢复，不能直接当作完整审计轨迹。Ensemble 若要长期保留完整委派消息与干预历史，需要自行定义记录与补读策略。

来源：[public-thread-api-surface.md，13–19、25–31 行](https://github.com/langgenius/mosoo/blob/465d9f26ec8e8d48d4bd02e61034cf3e7139c5b9/docs/prd/public-thread-api-surface.md#L13)。

## 依赖接入建议与待验证项

1. 优先借鉴统一事件、命令回执、会话与 Run 分离、能力声明和 Host Ports 的分层，暂不绑定整套 mosoo 云平台。
2. 按已确认的依赖选择接入 Driver，确定并锁定实际使用的包版本；验证能否在用户本机管理所需 Harness，并保留必要的原生能力。具体接入方式尚未确定。
3. CursorSDK 接入需要单独设计与验证；不能把 ACP 后端当作已支持 Cursor SDK 的证据。
4. 实时纠偏必须单独做能力适配，分别表达即时处理、轮次边界处理、排队和不支持；已有取消路径不能替代 steering。
5. 父子委派、任务原文与上下文记录、人类纠偏后同步主 Agent，以及 MCP 调用关联，仍属于 Ensemble 的产品工作。
6. 接入时需验证 Windows 路径、Bun / CLI 基线、native home 和恢复约束，以及 Linux 进程监督假设。Driver 文档说明原生恢复可能要求原绝对路径；其进程监督测试也有 Linux /proc 假设，不能据此宣称 Windows 已兼容。

来源：[Driver README：Runtime Protocol](https://github.com/langgenius/mosoo-agent-driver/blob/49df36e9735f261829ea90b6570382bd33a67775/README.md#runtime-protocol)、[Driver README：Artifact Live Tests](https://github.com/langgenius/mosoo-agent-driver/blob/49df36e9735f261829ea90b6570382bd33a67775/README.md#artifact-live-tests)。采用该依赖由用户明确决定；本节具体接入建议是针对 Ensemble 需求作出的推断，不是 mosoo 的官方承诺，也不代表实施细节已确认。

## 许可证

两个仓库所查版本均标明 Apache-2.0。若后续复制、修改并分发代码，应按各自 LICENSE 的条件保留许可与归属说明、标明修改，并处理随附 NOTICE（如有）。目前已确认采用 `@mosoo/agent-driver`，尚未安装依赖或复制实现进入 Ensemble。（这是研究当时的状态；此后的变化见文末“接入状态更新”。）

来源：[mosoo LICENSE](https://github.com/langgenius/mosoo/blob/465d9f26ec8e8d48d4bd02e61034cf3e7139c5b9/LICENSE)、[Driver LICENSE.txt](https://github.com/langgenius/mosoo-agent-driver/blob/49df36e9735f261829ea90b6570382bd33a67775/LICENSE.txt)。

## 接入状态更新（2026-11-08）

本文其余部分是研究当时（2026-11-07）的记录，不随接入进展改写。此后发生的事：

- 按用户的决定，没有把 `@mosoo/agent-driver` 作为 npm 依赖安装，而是把提交 `49df36e…` 的源码复制到 `vendor/mosoo-agent-driver`，并在其中新增了 Cursor SDK 后端；来源、拷贝范围、逐文件修改与已核对 / 未核对事项见 [VENDORING.md](../../vendor/mosoo-agent-driver/VENDORING.md)。
- 本文“依赖接入建议与待验证项”里的 Windows 路径、Bun / CLI 基线与 Linux `/proc` 假设：Kernel 在 Windows + Node 22.22.2 上加载并通过测试；上游的 Pi / Codex 后端仍带 POSIX / `/proc` 假设，没有登记，Codex 与 Pi 由 Ensemble 直接对接各自的控制接口。证据见 [docs/findings.md](../findings.md) 第 6 节。
- Cursor SDK 后端主要用假 SDK 测试；事件的顺序与形状另用一次经用户 SDK 网关（SDK 1.0.28，2026-11-08）的真实运行核对过，没有经 Ensemble 自己的 SDK 与凭据在真实账号上验证。