// 对照 vendor/mosoo-agent-driver 与导入时记录的上游基线，列出我们改过、新增或删掉的文件。
// Apache-2.0 要求在修改过的文件里保留“已修改”的醒目标注；这个脚本让这件事可以被机器检查：
//
//   node scripts/vendor-status.mjs           列出差异；有未登记的差异时退出码为 1
//   node scripts/vendor-status.mjs --write   重新记录基线（只应在“导入或升级上游”的那一次提交里使用）
//
// 基线文件 UPSTREAM-MANIFEST.json 记录的是上游原文的 SHA-256（按 LF 归一，避免 Windows 换行造成假差异）。
// 差异是否合理由 VENDORING.md 的“修改清单”说明；脚本要求清单里提到的文件和实际差异一致。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(root, "vendor", "mosoo-agent-driver");
const manifestPath = join(vendorDir, "UPSTREAM-MANIFEST.json");
const notesPath = join(vendorDir, "VENDORING.md");

/** 只比较“上游文件”所在的位置；我们自己的说明文件不在基线里。 */
const TRACKED_ROOTS = ["src", "LICENSE.txt", "UPSTREAM-README.md", "package.upstream.json"];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function hashOf(file) {
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(text).digest("hex");
}

function currentFiles() {
  const files = new Map();
  for (const tracked of TRACKED_ROOTS) {
    const full = join(vendorDir, tracked);
    if (!existsSync(full)) continue;
    const paths = statSync(full).isDirectory() ? walk(full) : [full];
    for (const file of paths) files.set(relative(vendorDir, file).split(sep).join("/"), hashOf(file));
  }
  return files;
}

const now = currentFiles();

if (process.argv.includes("--write")) {
  const manifest = {
    upstream: "https://github.com/langgenius/mosoo-agent-driver",
    commit: "49df36e9735f261829ea90b6570382bd33a67775",
    license: "Apache-2.0",
    files: Object.fromEntries([...now].sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`baseline written: ${now.size} files`);
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const base = new Map(Object.entries(manifest.files));
const modified = [];
const added = [];
const removed = [];
for (const [file, hash] of now) {
  if (!base.has(file)) added.push(file);
  else if (base.get(file) !== hash) modified.push(file);
}
for (const file of base.keys()) if (!now.has(file)) removed.push(file);

const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
const missingNotes = [...modified, ...added].filter((file) => !notes.includes(file));

const print = (title, list) => {
  console.log(`${title} (${list.length})`);
  for (const file of list) console.log(`  ${file}`);
};
console.log(`upstream ${manifest.upstream} @ ${manifest.commit}`);
print("modified", modified);
print("added", added);
print("removed (not vendored)", removed);
if (missingNotes.length > 0) {
  print("NOT DOCUMENTED in VENDORING.md", missingNotes);
  process.exit(1);
}
