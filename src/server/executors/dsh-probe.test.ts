import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shutdownTrackedEnvs } from "../testing";
import { DshExecutor } from "./dsh";
import { packagedFake, setup } from "./dsh.fakes";

afterEach(shutdownTrackedEnvs);

describe("DSH 探测", () => {
  it("版本、模型目录、每个模型自己的推理档位（目录只给当前模型的，所以逐个切过去读）", async () => {
    const { executor, requests } = setup({ FAKE_DSH_MODELS: "multi" });
    const info = await executor.probe();
    expect(info).toMatchObject({ id: "dsh", displayName: "DSH", runtime: "native", status: "ready", version: "0.2.2-rc.1", defaultModel: "deepseek-official/deepseek-v4-flash" });
    expect(info.models).toEqual([
      { id: "deepseek-official/deepseek-v4-flash", label: "deepseek-v4-flash", provider: "deepseek-official", efforts: ["off", "low", "high", "max"], defaultEffort: "high", isDefault: true },
      // “提供方默认”（空值）不是一个可选档位，也不是默认档位。
      { id: "deepseek-official/deepseek-v4-pro", label: "deepseek-v4-pro", provider: "deepseek-official", efforts: ["low", "high"] },
      // 没有推理档位选项的模型不展示档位。
      { id: "local/plain", label: "plain", provider: "local" },
    ]);
    expect(requests("session/set_config_option", "probe")).toHaveLength(2);
  });

  it("默认目录只有一个模型：不需要切换模型就能读到它的档位", async () => {
    const { executor, requests } = setup();
    const info = await executor.probe();
    expect(info.models).toEqual([{ id: "deepseek-official/deepseek-v4-flash", label: "deepseek-v4-flash", provider: "deepseek-official", efforts: ["off", "low", "high", "max"], defaultEffort: "high", isDefault: true }]);
    expect(requests("session/set_config_option", "probe")).toHaveLength(0);
  });

  it("访问级别与能力如实：只读由 DSH 自己强制，Full Access 没有沙箱；steer 不支持", async () => {
    const { executor } = setup();
    const info = await executor.probe();
    expect(info.access.read_only).toMatchObject({ level: "enforced", mechanism: expect.stringContaining("read-only") });
    expect(info.access.full).toMatchObject({ level: "none", mechanism: expect.stringContaining("no sandbox") });
    expect(info.capabilities.steer).toMatchObject({ support: "no", verification: "live" });
    expect(info.capabilities.followUp).toMatchObject({ support: "yes", mode: "after_run" });
    expect(info.capabilities.cancel).toMatchObject({ support: "yes", verification: "live" });
    expect(info.capabilities.resume).toMatchObject({ support: "yes", verification: "live" });
    // 没有独立的计划事件与逐项用量，不能说“完全支持”。
    expect(info.capabilities.plan.support).toBe("partial");
    expect(info.capabilities.usage.support).toBe("partial");
  });

  it("探测进程只读启动，会话存储与索引都改到临时目录，探测完整个目录删除（不在用户的 DSH_HOME 里留下会话）", async () => {
    const { executor, launches } = setup();
    await executor.probe();
    const [launch] = launches("probe");
    expect(launch?.permission).toBe("read-only");
    expect(launch?.args).toEqual(expect.arrayContaining(["--profile", "acp", "--patch"]));
    expect(launch?.patch).toContain("id: session-persistence-jsonl");
    expect(launch?.patch).toContain("id: storage-json");
    // 两个 root 都落在探测进程的工作目录（临时目录）之下。
    const roots = [...(launch?.patch ?? "").matchAll(/root: '(.+)'/g)].map((match) => match[1]);
    expect(roots).toHaveLength(2);
    for (const root of roots) expect(root!.startsWith(launch!.cwd!)).toBe(true);
    expect(existsSync(launch!.cwd!)).toBe(false);
  });

  it("DSH 的 acp 配置里没有模型时需要配置", async () => {
    const info = await setup({ FAKE_DSH_MODELS: "none" }).executor.probe();
    expect(info.status).toBe("needs_setup");
    expect(info.setup?.code).toBe("dsh_no_models");
  });

  it("没安装时如实说明，并给出官方安装命令", async () => {
    const info = await new DshExecutor({ bin: join(tmpdir(), "definitely-missing", "dsh.mjs") }).probe();
    expect(info.status).toBe("unavailable");
    expect(info.setup).toMatchObject({ code: "dsh_not_found", command: "npm install -g @deepseek-ai/dsh@latest" });
    expect(info.access.read_only?.level).toBe("none");
  });

  it("dsh --version 失败时带上它的原话，而不是笼统的“探测失败”", async () => {
    const info = await setup({ FAKE_DSH_VERSION_FAIL: "SyntaxError: Unexpected token '?.'" }).executor.probe();
    expect(info.status).toBe("unavailable");
    expect(info.setup?.code).toBe("dsh_probe_failed");
    expect(info.setup?.message).toContain("Unexpected token");
  });

  it("包声明的 Node 版本高于当前时，在失败说明里点明（不拒绝启动，只提示）", async () => {
    const bin = packagedFake(">=99.0.0");
    const failing = await setup({ FAKE_DSH_VERSION_FAIL: "boom" }, { bin }).executor.probe();
    expect(failing.setup?.message).toContain("declares Node >=99.0.0");
    expect(failing.setup?.message).toContain(process.version);
    // 能启动就照常就绪：声明与实测有出入时以实测为准。
    const working = await setup({}, { bin }).executor.probe();
    expect(working.status).toBe("ready");
  });

  it("ACP 协议版本不是 1：说明版本不兼容，仍然带上 dsh 的版本号", async () => {
    const info = await setup({ FAKE_DSH_PROTOCOL: "2" }).executor.probe();
    expect(info).toMatchObject({ status: "unavailable", version: "0.2.2-rc.1", setup: { code: "dsh_unsupported" } });
  });

  it("启动即崩溃时，原因里带上 stderr 的内容", async () => {
    const info = await setup({ FAKE_DSH_CRASH_ON_INIT: "profile acp is corrupted" }).executor.probe();
    expect(info.status).toBe("unavailable");
    expect(info.setup?.code).toBe("dsh_probe_failed");
    expect(info.setup?.message).toContain("profile acp is corrupted");
  });

  it("没有声明 resume 能力的 dsh：不宣称能恢复会话", async () => {
    const info = await setup({ FAKE_DSH_NO_RESUME: "1" }).executor.probe();
    expect(info.status).toBe("ready");
    expect(info.capabilities.resume).toMatchObject({ support: "no" });
  });
});
