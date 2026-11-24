import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const shared = fileURLToPath(new URL("./src/shared", import.meta.url));
const driver = fileURLToPath(new URL("./vendor/mosoo-agent-driver/src", import.meta.url)).replaceAll("\\", "/");

export default defineConfig({
  resolve: {
    // 与 tsconfig.base.json 的 paths 保持一致：@mosoo/agent-driver 指向仓库内的本地副本（见 VENDORING.md）。
    alias: [
      { find: "@shared", replacement: shared },
      { find: /^@mosoo\/agent-driver$/, replacement: `${driver}/index.ts` },
      { find: /^@mosoo\/agent-driver\/(.+)$/, replacement: `${driver}/$1` },
    ],
  },
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // 服务端集成测试会启动真实 HTTP 服务与子进程，串行更稳定。
    fileParallelism: false,
    // 测试用独立的临时目录根，结束后整体删除，不在系统临时目录里留垃圾。
    globalSetup: ["./test/global-setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: [
            "src/shared/**/*.test.ts",
            "src/server/**/*.test.ts",
            "src/mcp/**/*.test.ts",
            "src/cli/**/*.test.ts",
            "test/**/*.test.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "web",
          environment: "happy-dom",
          include: ["src/web/**/*.test.ts", "src/web/**/*.test.tsx"],
        },
      },
    ],
  },
});
