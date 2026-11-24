import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CURSOR_SDK_VERSION, ENV } from "@shared/constants";
import { silentLogger } from "../logger";
import { pathsFor } from "../paths";
import { shutdownTrackedEnvs } from "../testing";
import { CursorExecutor } from "./cursor";
import { typedError } from "./cursor-fake";
import { FAKE_KEY, setup } from "./cursor-test-kit";
import { createExecutors } from "./index";

afterEach(shutdownTrackedEnvs);

// ───────────────────────── probe ─────────────────────────

describe("Cursor probe", () => {
  it("reports the account's real model catalog and never claims verified capabilities", async () => {
    const { executor, fake } = setup();
    const info = await executor.probe();

    expect(info.status).toBe("ready");
    expect(info.version).toBe(`SDK ${CURSOR_SDK_VERSION}`);
    expect(info.account).toBe("dev@example.com");
    expect(info.defaultModel).toBe("auto");
    expect(info.models.map((m) => m.id)).toEqual(["auto", "composer-fake", "plain-fake"]);
    expect(info.models.find((m) => m.id === "auto")?.isDefault).toBe(true);
    expect(info.models.find((m) => m.id === "composer-fake")).toMatchObject({
      label: "Composer Fake",
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    });
    expect(info.models.find((m) => m.id === "plain-fake")?.efforts).toBeUndefined();

    // 没有在真实账号上验证过：任何能力都不能标成 live。
    expect(Object.values(info.capabilities).filter((capability) => capability.verification === "live")).toEqual([]);
    expect(info.access.read_only?.level).toBe("enforced");
    expect(info.access.full?.level).toBe("none");
    expect(Object.keys(info.access)).toEqual(["read_only", "full"]);
    expect(fake.authCalls).toBe(1);
  });

  it("is unavailable, with an install command, when the SDK cannot be loaded", async () => {
    const executor = new CursorExecutor({
      env: {},
      runtimeDir: "C:\\ensemble\\runtime",
      loadSdk: async () => {
        throw new Error("Cannot find package '@cursor/sdk'");
      },
    });
    const info = await executor.probe();
    expect(info.status).toBe("unavailable");
    expect(info.setup?.code).toBe("cursor_sdk_missing");
    expect(info.setup?.command).toContain('npm install --prefix "C:\\ensemble\\runtime"');
    expect(info.setup?.command).toContain(`@cursor/sdk@${CURSOR_SDK_VERSION}`);
  });

  it("needs setup, without calling the API, when there are no credentials at all", async () => {
    const { executor, fake } = setup({ configure: (f) => (f.authStatus = { status: "logged-out" }) });
    const info = await executor.probe();
    expect(info.status).toBe("needs_setup");
    expect(info.setup?.code).toBe("cursor_login_required");
    expect(info.setup?.command).toContain("cursor-login");
    expect(fake.modelsCalls).toHaveLength(0);
  });

  it("uses CURSOR_API_KEY even when no stored login exists, and never echoes the key", async () => {
    const { executor, fake } = setup({
      env: { CURSOR_API_KEY: FAKE_KEY },
      configure: (f) => (f.authStatus = { status: "logged-out" }),
    });
    const info = await executor.probe();
    expect(info.status).toBe("ready");
    expect(fake.modelsCalls[0]).toEqual({ apiKey: FAKE_KEY });
    expect(JSON.stringify(info)).not.toContain(FAKE_KEY);
  });

  it("does not treat a failing status query as being logged out", async () => {
    const { executor } = setup({ configure: (f) => (f.authError = new Error("keychain unavailable")) });
    expect((await executor.probe()).status).toBe("ready");
  });

  it("asks for new credentials when Cursor rejects them", async () => {
    const { executor } = setup({
      configure: (f) => (f.modelsError = typedError("AuthenticationError", "Unauthorized", { status: 401, isRetryable: false })),
    });
    const info = await executor.probe();
    expect(info.status).toBe("needs_setup");
    expect(info.setup?.code).toBe("cursor_auth_rejected");
    expect(info.setup?.message).toContain("Unauthorized");
  });

  it("is unavailable, not logged-out, when the network call fails", async () => {
    const { executor } = setup({ configure: (f) => (f.modelsError = new Error("fetch failed")) });
    const info = await executor.probe();
    expect(info.status).toBe("unavailable");
    expect(info.setup).toMatchObject({ code: "cursor_probe_failed" });
  });

  it("needs setup when the account has no models", async () => {
    const { executor } = setup({ configure: (f) => (f.models = []) });
    const info = await executor.probe();
    expect(info.status).toBe("needs_setup");
    expect(info.setup?.code).toBe("cursor_no_models");
  });
});


// ───────────────────────── 注册 ─────────────────────────

describe("executor registry", () => {
  const paths = pathsFor(join(tmpdir(), "ensemble-cursor-registry"));

  it("includes the real Cursor adapter by default", () => {
    const executors = createExecutors({ env: {}, paths, log: silentLogger });
    expect(executors.map((e) => e.id).sort()).toEqual(["claude", "codex", "cursor", "dsh", "opencode", "pi"]);
    expect(executors.find((e) => e.id === "cursor")).toBeInstanceOf(CursorExecutor);
  });

  it("swaps in the labelled simulator only when asked to", () => {
    const executors = createExecutors({ env: { [ENV.fixture]: "cursor" }, paths, log: silentLogger });
    expect(executors.find((e) => e.id === "cursor")).not.toBeInstanceOf(CursorExecutor);
  });
});
