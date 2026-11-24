import { describe, expect, it } from "vitest";
import { CURSOR_SDK_VERSION } from "@shared/constants";
import type { Json } from "../server/executors/common";
import type { CursorSdk } from "../server/executors/cursor-sdk-loader";
import { runCursorLogin, type CursorLoginIO } from "./cursor-login";

const SECRET = "key_test_this_must_never_be_printed";

interface Harness {
  sdk: CursorSdk;
  loginCalls: Json[];
  logoutCalls: number;
  state: { status: unknown; loginError?: Error; loginImpl?: (options: Json) => Promise<unknown> };
}

function fakeSdk(initial: unknown = { status: "logged-out" }, withLogin = true): Harness {
  const harness: Harness = {
    loginCalls: [],
    logoutCalls: 0,
    state: { status: initial },
    sdk: undefined as unknown as CursorSdk,
  };
  harness.sdk = {
    Agent: { create: async () => Promise.reject(new Error("unused")), resume: async () => Promise.reject(new Error("unused")) },
    Cursor: {
      models: { list: async () => [] },
      me: async () => ({}),
      auth: {
        status: async () => harness.state.status,
        ...(withLogin
          ? {
              login: async (options?: Json) => {
                harness.loginCalls.push(options ?? {});
                if (harness.state.loginError) throw harness.state.loginError;
                if (harness.state.loginImpl) return harness.state.loginImpl(options ?? {});
                return { apiKey: SECRET, email: "dev@example.com", apiKeyExpiresAtMs: Date.parse("2027-02-05T00:00:00Z") };
              },
              logout: async () => {
                harness.logoutCalls += 1;
              },
            }
          : {}),
      },
    },
  };
  return harness;
}

function run(harness: Harness, flags: string[], io: Partial<CursorLoginIO> & { answers?: boolean[] } = {}, env: NodeJS.ProcessEnv = {}) {
  const lines: string[] = [];
  const errors: string[] = [];
  const questions: string[] = [];
  const answers = [...(io.answers ?? [])];
  const result = runCursorLogin({
    flags: new Set(flags),
    env,
    runtimeDir: "C:\\ensemble\\runtime",
    loadSdk: async () => ({ sdk: harness.sdk, version: CURSOR_SDK_VERSION }),
    io: {
      out: (text = "") => void lines.push(text),
      err: (text = "") => void errors.push(text),
      interactive: io.interactive ?? true,
      confirm: async (question) => {
        questions.push(question);
        return answers.shift() ?? false;
      },
    },
    timeoutMs: 2_000,
  });
  return { result, lines, errors, questions, all: () => [...lines, ...errors].join("\n") };
}

describe("cursor-login", () => {
  it("explains what it will do before asking, and only logs in after a yes", async () => {
    const harness = fakeSdk();
    const { result, lines, questions, all } = run(harness, [], { answers: [true] });
    expect(await result).toBe(0);

    // 说明先于询问；说明里要讲清楚创建 API Key、有效期和保存位置。
    expect(questions).toEqual(["继续登录？"]);
    const text = lines.join("\n");
    expect(text).toContain("创建一把名为");
    expect(text).toContain("90 天后到期");
    expect(text).toContain("~/.cursor/sdk/auth.json");

    expect(harness.loginCalls).toHaveLength(1);
    expect(harness.loginCalls[0]).toMatchObject({ apiKeyTtlMs: 90 * 24 * 60 * 60 * 1000, openBrowser: true });
    expect(String(harness.loginCalls[0]?.["apiKeyName"])).toMatch(/^Ensemble · /);
    expect(text).toContain("登录成功：dev@example.com");
    expect(text).toContain("2027-02-05");
    // 密钥只由 SDK 保存，绝不显示。
    expect(all()).not.toContain(SECRET);
  });

  it("does nothing when the user declines", async () => {
    const harness = fakeSdk();
    const { result, lines } = run(harness, [], { answers: [false] });
    expect(await result).toBe(1);
    expect(harness.loginCalls).toHaveLength(0);
    expect(lines.join("\n")).toContain("没有做任何改动");
  });

  it("refuses to proceed non-interactively without --yes, and proceeds with it", async () => {
    const refused = fakeSdk();
    const first = run(refused, [], { interactive: false });
    expect(await first.result).toBe(2);
    expect(refused.loginCalls).toHaveLength(0);
    expect(first.errors.join("\n")).toContain("--yes");

    const allowed = fakeSdk();
    const second = run(allowed, ["yes"], { interactive: false });
    expect(await second.result).toBe(0);
    expect(allowed.loginCalls).toHaveLength(1);
    expect(second.questions).toEqual([]);
  });

  it("does not log in again when already signed in, unless forced", async () => {
    const signedIn = { status: "logged-in", backendUrl: "https://api.example.test", email: "dev@example.com", apiKeyExpiresAtMs: Date.parse("2027-01-01T00:00:00Z") };
    const harness = fakeSdk(signedIn);
    const plain = run(harness, [], { answers: [true] });
    expect(await plain.result).toBe(0);
    expect(harness.loginCalls).toHaveLength(0);
    expect(plain.lines.join("\n")).toContain("--force");

    const forced = run(harness, ["force", "yes"]);
    expect(await forced.result).toBe(0);
    expect(harness.loginCalls).toHaveLength(1);
  });

  it("reports the status without changing anything, and mentions CURSOR_API_KEY precedence", async () => {
    const harness = fakeSdk({ status: "logged-in", backendUrl: "https://api.example.test", email: "dev@example.com", apiKeyExpiresAtMs: Date.parse("2027-01-01T00:00:00Z") });
    const { result, lines } = run(harness, ["status"], {}, { CURSOR_API_KEY: SECRET });
    expect(await result).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("已登录 Cursor：dev@example.com");
    expect(text).toContain("2027-01-01");
    expect(text).toContain("CURSOR_API_KEY");
    expect(text).not.toContain(SECRET);
    expect(harness.loginCalls).toHaveLength(0);

    const loggedOut = run(fakeSdk(), ["status"]);
    expect(await loggedOut.result).toBe(0);
    expect(loggedOut.lines.join("\n")).toContain("没有保存的 Cursor 登录");
  });

  it("logs out only after confirmation, and says the minted key stays valid until revoked", async () => {
    const harness = fakeSdk({ status: "logged-in", backendUrl: "https://api.example.test" });
    const declined = run(harness, ["logout"], { answers: [false] });
    expect(await declined.result).toBe(1);
    expect(harness.logoutCalls).toBe(0);
    expect(declined.lines.join("\n")).toContain("到期前仍然有效");

    const accepted = run(harness, ["logout"], { answers: [true] });
    expect(await accepted.result).toBe(0);
    expect(harness.logoutCalls).toBe(1);

    const nothing = run(fakeSdk(), ["logout"]);
    expect(await nothing.result).toBe(0);
    expect(nothing.lines.join("\n")).toContain("没有保存的 Cursor 登录");
  });

  it("reports a login that did not finish without leaking anything", async () => {
    const harness = fakeSdk();
    harness.state.loginError = Object.assign(new Error("Login was cancelled in the browser"), { name: "AuthenticationError" });
    const { result, errors, all } = run(harness, [], { answers: [true] });
    expect(await result).toBe(1);
    expect(errors.join("\n")).toContain("登录没有完成：Login was cancelled in the browser");
    expect(all()).not.toContain(SECRET);
  });

  it("shows the login URL through the SDK callback so a headless session can still finish", async () => {
    const harness = fakeSdk();
    harness.state.loginImpl = async (options) => {
      (options["onLoginUrl"] as (url: string) => void)("https://cursor.example.test/login?code=abc");
      return { apiKey: SECRET, email: "dev@example.com", apiKeyExpiresAtMs: Date.parse("2027-02-05T00:00:00Z") };
    };
    const { result, errors } = run(harness, ["yes"]);
    expect(await result).toBe(0);
    expect(errors.join("\n")).toContain("https://cursor.example.test/login?code=abc");
  });

  it("points at CURSOR_API_KEY when this SDK build cannot sign in", async () => {
    const { result, errors } = run(fakeSdk({ status: "logged-out" }, false), ["yes"]);
    expect(await result).toBe(1);
    expect(errors.join("\n")).toContain("CURSOR_API_KEY");
  });

  it("gives the install command when the SDK is missing", async () => {
    const errors: string[] = [];
    const code = await runCursorLogin({
      flags: new Set(),
      env: {},
      runtimeDir: "C:\\ensemble\\runtime",
      loadSdk: async () => {
        throw new Error("Cannot find package '@cursor/sdk'");
      },
      io: { out: () => undefined, err: (text = "") => void errors.push(text), interactive: true, confirm: async () => true },
    });
    expect(code).toBe(1);
    const text = errors.join("\n");
    expect(text).toContain('npm install --prefix "C:\\ensemble\\runtime"');
    expect(text).toContain(`@cursor/sdk@${CURSOR_SDK_VERSION}`);
  });
});
