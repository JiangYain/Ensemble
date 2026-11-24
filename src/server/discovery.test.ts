import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readServiceFile, serviceSupports } from "./discovery";
import { pathsFor } from "./paths";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** 写一份 service.json（老服务写的那种没有 features 字段），读回来。 */
async function roundTrip(extra: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), "ensemble-discovery-"));
  homes.push(home);
  const paths = pathsFor(home);
  mkdirSync(paths.run, { recursive: true });
  writeFileSync(paths.serviceFile, JSON.stringify({ pid: 4242, port: 47821, url: "http://127.0.0.1:47821", token: "t", version: "0.1.0", protocol: 1, startedAt: "2026-11-16T05:42:25.032Z", home, ...extra }));
  return readServiceFile(paths);
}

describe("negotiable service features", () => {
  it("an older service wrote no features, and that reads as supporting nothing", async () => {
    const file = await roundTrip({});
    expect(file).toBeDefined();
    expect(file?.features).toBeUndefined();
    expect(serviceSupports(file, "declared-session-ref")).toBe(false);
    expect(serviceSupports(undefined, "declared-session-ref")).toBe(false);
  });

  it("a newer service lists what it supports", async () => {
    const file = await roundTrip({ features: ["declared-session-ref", "something-later"] });
    expect(file?.features).toEqual(["declared-session-ref", "something-later"]);
    expect(serviceSupports(file, "declared-session-ref")).toBe(true);
  });

  it("anything that is not a list of strings is treated as no features at all", async () => {
    for (const bad of ["declared-session-ref", { "declared-session-ref": true }, 7, null]) {
      const file = await roundTrip({ features: bad });
      expect(file, JSON.stringify(bad)).toBeDefined();
      expect(serviceSupports(file, "declared-session-ref"), JSON.stringify(bad)).toBe(false);
    }
    const mixed = await roundTrip({ features: ["declared-session-ref", 3, null, { x: 1 }] });
    expect(mixed?.features).toEqual(["declared-session-ref"]);
  });

  it("does not change what makes a service file usable", async () => {
    const home = mkdtempSync(join(tmpdir(), "ensemble-discovery-"));
    homes.push(home);
    const paths = pathsFor(home);
    expect(await readServiceFile(paths)).toBeUndefined();
    mkdirSync(paths.run, { recursive: true });
    writeFileSync(paths.serviceFile, JSON.stringify({ port: 1 }));
    expect(await readServiceFile(paths)).toBeUndefined();
    writeFileSync(paths.serviceFile, "not json");
    expect(await readServiceFile(paths)).toBeUndefined();
  });
});
