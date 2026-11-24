// 生成 dist/THIRD-PARTY-NOTICES.txt：把真正被打进 dist/ensemble.mjs 与 dist/web 的第三方库，连同它们的许可证全文列在一处。
// 由 scripts/build.mjs 在完整构建时调用；内容全部取自这次构建的输入，不要手改。
//
// 为什么需要它：MIT / ISC / BSD / Apache-2.0 都要求分发时附带版权与许可声明。esbuild 与 Vite 打包之后，
// 这些声明不会留在产物里（服务端构建用了 legalComments: "none"），所以单独生成一份随 dist/ 走：
// 它会进入 npm 包，也会随 install 被复制进插件目录。
//
// 两道保险：
//  - 被打进包的第三方库如果没有随包带许可证文件、而 scripts/third-party/ 里也没有补上，构建直接失败，不会悄悄漏掉；
//  - 许可证不在下面的白名单里（比如 GPL / AGPL）也直接失败，由人决定能不能打进去。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** 可以打进分发产物的许可证（SPDX 标识）。要放行新的，先确认它的条款允许、并且声明已随包分发。 */
const ALLOWED_LICENSES = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Apache-2.0"]);

const LICENSE_FILE_NAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md", "LICENSE-MIT", "LICENSE-MIT.txt", "license", "license.md", "license.txt", "COPYING"];

const RULE = "=".repeat(78);
const THIN = "-".repeat(78);

function read(file) {
  return readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
}

/**
 * 把一条被打包进来的模块路径归到它所属的 npm 包。
 * 不在 node_modules 里（我们自己的源码、vendor/）、或是打包器自己注入的虚拟模块（路径里带 \0）返回 undefined。
 * 路径可以是相对的（esbuild 的 metafile）或绝对的（Rollup / Rolldown），分隔符不限。
 */
export function packageOfModule(root, file) {
  if (file.includes("\0")) return undefined;
  const normalized = file.replace(/\\/g, "/");
  const marker = "node_modules/";
  const at = normalized.lastIndexOf(marker);
  if (at < 0) return undefined;
  const parts = normalized.slice(at + marker.length).split("/");
  const name = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : parts[0];
  if (!name || name.endsWith("/")) return undefined;
  return { name, dir: resolve(root, normalized.slice(0, at + marker.length), name) };
}

function licenseOf(manifest) {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license && typeof manifest.license.type === "string") return manifest.license.type;
  if (Array.isArray(manifest.licenses)) return manifest.licenses.map((entry) => entry?.type).filter(Boolean).join(" OR ");
  return undefined;
}

function sourceOf(manifest) {
  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  const cleaned = repository
    ?.replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^github:/, "https://github.com/")
    .replace(/\.git$/, "");
  return manifest.homepage ?? cleaned;
}

function describePackage(root, { name, dir }) {
  const manifestFile = join(dir, "package.json");
  if (!existsSync(manifestFile)) throw new Error(`第三方包 ${name} 没有 package.json（${dir}），无法写入它的许可证说明。`);
  const manifest = JSON.parse(read(manifestFile));
  const version = String(manifest.version ?? "0.0.0");
  const license = licenseOf(manifest);
  if (!license) throw new Error(`${name}@${version} 的 package.json 没有声明许可证，不能把它打进分发产物。`);
  const ids = license.replace(/[()]/g, " ").split(/\s+(?:OR|AND)\s+/i).map((id) => id.trim());
  if (!ids.every((id) => ALLOWED_LICENSES.has(id))) {
    throw new Error(`${name}@${version} 的许可证是 ${license}，不在 scripts/notices.mjs 的放行名单里（${[...ALLOWED_LICENSES].join(", ")}）。先确认它的条款允许被打进来，再把它加进名单。`);
  }

  const shipped = LICENSE_FILE_NAMES.map((candidate) => join(dir, candidate)).find((candidate) => existsSync(candidate));
  const supplied = join(root, "scripts", "third-party", `${name.replace("/", "__")}.LICENSE`);
  if (!shipped && !existsSync(supplied)) {
    throw new Error(`${name}@${version} 没有随包带许可证文件，scripts/third-party/ 里也没有补上它（需要 ${name.replace("/", "__")}.LICENSE，内容取自它的上游仓库）。`);
  }
  return { name, version, license, source: sourceOf(manifest), text: read(shipped ?? supplied), fromUpstream: !shipped };
}

/** 把一批模块路径归并成去重、排好序的第三方包清单。 */
export function collectPackages(root, files) {
  const dirs = new Map();
  for (const file of files) {
    const found = packageOfModule(root, file);
    if (found) dirs.set(found.dir, found);
  }
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...dirs.values()].map((found) => describePackage(root, found)).sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version));
}

function entry(pkg) {
  const lines = [THIN, `${pkg.name} ${pkg.version}`, `License: ${pkg.license}`];
  if (pkg.source) lines.push(`Source:  ${pkg.source}`);
  if (pkg.fromUpstream) lines.push("The npm package ships no licence file; the text below is the LICENSE of its upstream repository.");
  lines.push(THIN, "", pkg.text, "");
  return lines.join("\n");
}

function part(title, intro, body) {
  return [RULE, title, RULE, "", ...(intro ? [intro, ""] : []), body].join("\n");
}

/**
 * 写 dist/THIRD-PARTY-NOTICES.txt。
 * @param {{ root: string, serverFiles: string[], webFiles: string[], outFile?: string }} options
 *   serverFiles：esbuild metafile 里实际进了 dist/ensemble.mjs 的输入文件；webFiles：Vite 输出里各 chunk 的模块 id。
 */
export function writeThirdPartyNotices({ root, serverFiles, webFiles, outFile = join(root, "dist", "THIRD-PARTY-NOTICES.txt") }) {
  const server = collectPackages(root, serverFiles);
  const web = collectPackages(root, webFiles);

  const header = [
    "THIRD-PARTY NOTICES — Ensemble",
    RULE,
    "",
    "Ensemble itself is released under the MIT License (see LICENSE).",
    "",
    "The files shipped here — dist/ensemble.mjs and dist/web/ — are bundles. They contain, in compiled",
    "form, the third-party code listed below, and the licences of that code ask for their notices to be",
    "distributed with it. This file is generated by scripts/build.mjs from the inputs of the build that",
    "produced those files. Do not edit it by hand; run `npm run build`.",
    "",
    "  1. Notice file of the Ensemble repository (NOTICE)",
    "  2. npm packages bundled into dist/ensemble.mjs (local service, MCP bridge, command line)",
    "  3. npm packages bundled into dist/web/ (web panel)",
    "  4. Licence texts referred to in part 1",
    "",
  ].join("\n");

  const noticeFile = read(join(root, "NOTICE"));
  const apache = read(join(root, "vendor", "mosoo-agent-driver", "LICENSE.txt"));
  const fonts = read(join(root, "src", "web", "fonts", "LICENSE.txt"));
  const cormorant = read(join(root, "src", "web", "public", "licenses", "CORMORANT-OFL.txt"));

  const text = [
    header,
    part("1. Notice file of the Ensemble repository (NOTICE)", "Reproduced as it is in the repository; the licence texts it refers to are in part 4 below.", `${noticeFile}\n`),
    part(
      "2. npm packages bundled into dist/ensemble.mjs",
      [
        "The Cursor SDK (@cursor/sdk) is not bundled and is not part of this package: its licence does not",
        "allow redistribution, so it is installed on the user's machine on request.",
      ].join("\n"),
      server.map(entry).join("\n"),
    ),
    part(
      "3. npm packages bundled into dist/web/",
      [
        "Module-loading helper code that the bundler itself injects (Rolldown, Vite) is generated output and is",
        "not listed. Fonts are in part 4; the harness and model marks are described in dist/web/licenses/.",
      ].join("\n"),
      web.map(entry).join("\n"),
    ),
    part(
      "4. Licence texts referred to in part 1",
      null,
      [
        THIN,
        "Apache License 2.0 — mosoo-agent-driver (code vendored into dist/ensemble.mjs, modified by Ensemble) and",
        "the Agent Plugins JSON Schemas named in part 1 (used only for offline tests; not shipped in this package)",
        THIN,
        "",
        apache,
        "",
        THIN,
        "SIL Open Font License 1.1 — Inter and JetBrains Mono (dist/web/assets/*.woff2)",
        THIN,
        "",
        fonts,
        "",
        THIN,
        "SIL Open Font License 1.1 — Cormorant Garamond (dist/web/assets/cormorant-garamond-*.woff2)",
        THIN,
        "",
        cormorant,
        "",
      ].join("\n"),
    ),
  ].join("\n");

  writeFileSync(outFile, `${text.replace(/\n{4,}/g, "\n\n\n").trimEnd()}\n`, "utf8");
  return { file: outFile, packages: server.length + web.length };
}
