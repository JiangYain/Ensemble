// 构建：把本地服务 + MCP 桥 + CLI 打成单个可直接运行的文件 dist/ensemble.mjs，
// 并用 Vite 构建网页到 dist/web。插件安装时不会执行构建，所以 dist/ 需要随仓库提交。
// 完整构建还会生成 dist/THIRD-PARTY-NOTICES.txt（被打进包里的第三方库及其许可证，见 scripts/notices.mjs）。
//
//   node scripts/build.mjs            两者都构建
//   node scripts/build.mjs --server   只构建服务/桥
//   node scripts/build.mjs --web      只构建网页
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build as esbuild } from "esbuild";
import { writeThirdPartyNotices } from "./notices.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const args = new Set(process.argv.slice(2));
const wantServer = args.has("--server") || !args.has("--web");
const wantWeb = args.has("--web") || !args.has("--server");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

function size(file) {
  return `${(statSync(file).size / 1024).toFixed(0)} KB`;
}

// 两份产物各自实际用到了哪些输入文件：用来生成第三方许可证说明。
let serverFiles = [];
let webFiles = [];

if (wantServer) {
  const started = Date.now();
  const result = await esbuild({
    entryPoints: ["src/cli/main.ts"],
    outfile: "dist/ensemble.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    tsconfig: "tsconfig.node.json",
    // Cursor SDK 带原生模块与大量依赖，按需懒加载，不打进包里。
    external: ["@cursor/sdk"],
    banner: {
      js: [
        "#!/usr/bin/env node",
        "import { createRequire as __ensembleCreateRequire } from 'node:module';",
        "const require = __ensembleCreateRequire(import.meta.url);",
      ].join("\n"),
    },
    define: { __ENSEMBLE_VERSION__: JSON.stringify(pkg.version) },
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
  });
  const output = Object.entries(result.metafile.outputs).find(([file]) => file.replace(/\\/g, "/").endsWith("dist/ensemble.mjs"))?.[1];
  if (!output) throw new Error("esbuild 的 metafile 里没有 dist/ensemble.mjs，无法生成第三方许可证说明。");
  serverFiles = Object.entries(output.inputs)
    .filter(([, info]) => info.bytesInOutput > 0)
    .map(([file]) => file);
  console.log(`server  dist/ensemble.mjs  ${size("dist/ensemble.mjs")}  (${Date.now() - started} ms)`);
}

if (wantWeb) {
  const started = Date.now();
  const { build } = await import("vite");
  const result = await build({ configFile: join(root, "vite.config.ts"), logLevel: "warn" });
  for (const bundle of Array.isArray(result) ? result : [result]) {
    for (const item of "output" in bundle ? bundle.output : []) {
      if (item.type !== "chunk") continue;
      for (const [id, info] of Object.entries(item.modules ?? {})) if ((info.renderedLength ?? 1) > 0) webFiles.push(id);
    }
  }
  console.log(`web     dist/web           (${Date.now() - started} ms)`);
}

if (wantServer && wantWeb) {
  const { packages } = writeThirdPartyNotices({ root, serverFiles, webFiles });
  console.log(`notices dist/THIRD-PARTY-NOTICES.txt  (${packages} 个第三方包)`);
} else {
  console.log("notices 只在完整构建时更新（node scripts/build.mjs）。");
}
