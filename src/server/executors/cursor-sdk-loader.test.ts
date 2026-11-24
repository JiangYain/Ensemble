import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asCursorSdkAgentApi, loadCursorSdkPackage } from "@mosoo/agent-driver";
import { CURSOR_SDK_VERSION, ENV } from "@shared/constants";
import { defaultSdkLoader } from "./cursor-sdk-loader";

describe("recognising the SDK module", () => {
  // 真实 SDK 的 Agent / Cursor 是带静态方法的类（函数）。
  class Agent {
    static async create(): Promise<never> {
      throw new Error("not used");
    }
    static async resume(): Promise<never> {
      throw new Error("not used");
    }
  }

  it("accepts an Agent that is a class, directly or under `default`", () => {
    const sdkModule = { Agent, Cursor: class Cursor {} };
    expect(asCursorSdkAgentApi(sdkModule)).toBe(sdkModule);
    expect(asCursorSdkAgentApi({ default: sdkModule })).toBe(sdkModule);
  });

  it("explains what is missing when the module is not the SDK", () => {
    expect(() => asCursorSdkAgentApi({})).toThrow("does not export the Cursor SDK's Agent");
    expect(() => asCursorSdkAgentApi({ Agent: 1 })).toThrow("does not export the Cursor SDK's Agent");
  });
});

// ───────────────────────── 真实 SDK ─────────────────────────

describe("the installed @cursor/sdk package", () => {
  it("loads through the driver's own default loader as well (the backend works without a host-supplied loader)", async () => {
    const api = await loadCursorSdkPackage();
    expect(typeof api.Agent.create).toBe("function");
    expect(typeof api.Agent.resume).toBe("function");
  });

  it("loads through the production loader and exposes the surface the adapter calls", async () => {
    const loaded = await defaultSdkLoader({ env: {} })();
    expect(loaded.version).toBe(CURSOR_SDK_VERSION);
    const { sdk } = loaded;
    expect(typeof sdk.Agent.create).toBe("function");
    expect(typeof sdk.Agent.resume).toBe("function");
    expect(typeof sdk.Cursor.models.list).toBe("function");
    expect(typeof sdk.Cursor.me).toBe("function");
    expect(typeof sdk.Cursor.auth.status).toBe("function");
  });

  it("can be located from an explicit directory, and falls back to the normal install when that directory is wrong", async () => {
    const fromDirectory = await defaultSdkLoader({ env: { [ENV.cursorSdk]: process.cwd() } })();
    expect(fromDirectory.version).toBe(CURSOR_SDK_VERSION);

    const wrong = join(mkdtempSync(join(tmpdir(), "ensemble-cursor-nosdk-")), "nothing-here");
    const fallback = await defaultSdkLoader({ env: { [ENV.cursorSdk]: wrong } })();
    expect(fallback.version).toBe(CURSOR_SDK_VERSION);
  });

  it("answers logged-out for an empty in-memory credential store (the user's real credentials are never touched)", async () => {
    const real = await import("@cursor/sdk");
    const status = await real.Cursor.auth.status({ store: new real.InMemoryCredentialStore() });
    expect(status.status).toBe("logged-out");
  });
});
