import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfilesResponse } from "@shared/protocol";
import { EnsembleError } from "./errors";
import { silentLogger } from "./logger";
import { api, boot, closeServices, tempHome } from "./service.fixtures";
import { SettingsStore } from "./settings";

/**
 * 给不存在的角色改名：要改名的资源不在，404 `not_found`，`details.name` 是请求里原样写的名字；
 * 与新名字不合规、已被占用这两种请求本身的问题（400 `invalid_request`）分开。
 * 委派时按名字找不到角色是另一个错误（422 `profile_not_found`，见 profiles.test.ts 与 service.profiles.test.ts），这里不碰。
 * 其余改名规则的断言在 settings.profiles.test.ts 与 service.profiles.test.ts；这里只钉“不存在”这一种的码。
 * 全部用临时目录，从不碰真实的 settings.json。
 */

afterEach(closeServices);

async function openedWith(profiles: Record<string, unknown>): Promise<{ file: string; store: SettingsStore }> {
  const dir = await mkdtemp(join(tmpdir(), "ensemble-rename-missing-"));
  const file = join(dir, "settings.json");
  await writeFile(file, JSON.stringify({ version: 1, harnesses: {}, profiles }));
  return { file, store: await SettingsStore.open(file, silentLogger) };
}

/** 等一个应当被拒绝的调用，把拒绝的原因交回来；它没被拒绝、或拒绝的不是业务错误，都让测试失败。 */
async function refusal(pending: Promise<unknown>): Promise<EnsembleError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof EnsembleError) return error;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

const namesOf = (store: SettingsStore): string[] => store.profilesView().entries.map((entry) => entry.name);

describe("给不存在的角色改名：存储层", () => {
  it("是 not_found（404），details.name 与文案里都是请求里原样写的名字；不写盘、不通知、不动现有角色", async () => {
    const { file, store } = await openedWith({ scout: { harness: "pi" }, verify: { harness: "codex" } });
    const changed = vi.fn();
    store.onProfilesChange(changed);
    const before = await readFile(file, "utf8");

    const error = await refusal(store.renameProfile(" Ghost ", "other"));

    expect(error.code).toBe("not_found");
    expect(error.status).toBe(404);
    expect(error.message).toBe('There is no role named " Ghost ".');
    expect(error.details).toEqual({ name: " Ghost " });
    expect(changed).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe(before);
    expect(namesOf(store)).toEqual(["scout", "verify"]);
  });

  it("没有任何角色时也一样：不存在就是不存在", async () => {
    const { file, store } = await openedWith({});
    const before = await readFile(file, "utf8");

    const error = await refusal(store.renameProfile("ghost", "x"));

    expect(error.code).toBe("not_found");
    expect(error.status).toBe(404);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("只改了“不存在”这一种：新名字不合规、已被占用仍是 invalid_request（400）", async () => {
    const { file, store } = await openedWith({ a: { harness: "pi" }, b: { harness: "codex" } });
    const before = await readFile(file, "utf8");

    for (const to of ["b", "not ok", "123"]) {
      const error = await refusal(store.renameProfile("a", to));
      expect(error.code, `rename a to "${to}"`).toBe("invalid_request");
      expect(error.status, `rename a to "${to}"`).toBe(400);
    }

    expect(await readFile(file, "utf8")).toBe(before);
    expect(namesOf(store)).toEqual(["a", "b"]);
  });

  it("被拒绝之后写盘队列照常往下走：随后的改名成功", async () => {
    const { store } = await openedWith({ scout: { harness: "pi" } });

    await refusal(store.renameProfile("ghost", "x"));
    await store.renameProfile("scout", "ranger");

    expect(namesOf(store)).toEqual(["ranger"]);
  });
});

describe("给不存在的角色改名：HTTP", () => {
  interface ErrorBody {
    error: { code: string; message: string; details?: Record<string, unknown> };
  }

  it("404 not_found，正文带着原样的名字；settings.json 一个字节都不变，之后的改名照常成功", async () => {
    const home = tempHome("ensemble-rename-missing-http-");
    // 显式传入 env：不读测试进程自己的环境变量。
    const service = await boot({ home, env: {} });
    const client = api(service);
    expect((await client.put("/api/profiles/scout", { harness: "pi" })).status).toBe(200);
    const before = await readFile(join(home, "settings.json"), "utf8");

    const missing = await client.post(`/api/profiles/${encodeURIComponent(" Ghost ")}/rename`, { to: "other" });

    expect(missing.status).toBe(404);
    expect(await client.json<ErrorBody>(missing)).toEqual({
      error: { code: "not_found", message: 'There is no role named " Ghost ".', details: { name: " Ghost " } },
    });
    expect(await readFile(join(home, "settings.json"), "utf8")).toBe(before);

    const renamed = await client.post("/api/profiles/scout/rename", { to: "ranger" });
    expect(renamed.status).toBe(200);
    expect((await client.json<ProfilesResponse>(renamed)).profiles.entries.map((entry) => entry.name)).toEqual(["ranger"]);
  });

  it("原名字存在而新名字被占用、不合规时，仍是 400 invalid_request", async () => {
    const service = await boot({ env: {} });
    const client = api(service);
    await client.put("/api/profiles/a", { harness: "pi" });
    await client.put("/api/profiles/b", { harness: "pi" });

    const taken = await client.post("/api/profiles/a/rename", { to: "b" });
    const invalid = await client.post("/api/profiles/a/rename", { to: "not ok" });

    expect(taken.status).toBe(400);
    expect((await client.json<ErrorBody>(taken)).error.code).toBe("invalid_request");
    expect(invalid.status).toBe(400);
    expect((await client.json<ErrorBody>(invalid)).error.code).toBe("invalid_request");
  });
});
