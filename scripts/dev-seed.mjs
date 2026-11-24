// 开发辅助：向一个正在运行的（模拟执行端）本地服务灌入一组有代表性的委派，
// 用来在浏览器里检查各种状态的界面，也可以用来截图。
//
//   $env:ENSEMBLE_HOME = "$env:TEMP\ensemble-visual"
//   $env:ENSEMBLE_FIXTURE = "all"
//   node dist/ensemble.mjs serve --no-idle-exit        # 一个终端
//   node scripts/dev-seed.mjs                          # 另一个终端
//
// 选项： --minimal  只派两个会话（空状态之后的第一印象）
//        --no-steer 不对 hold 会话发送纠偏，让它停在“等待指示”
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";

const home = process.env.ENSEMBLE_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"), "Ensemble");
const info = JSON.parse(readFileSync(join(home, "run", "service.json"), "utf8"));
const args = new Set(process.argv.slice(2));
const cwd = resolve(".");

async function call(method, path, body, { bridge = false } = {}) {
  const response = await fetch(`${info.url}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-ensemble-token": info.token,
      // 带上 MCP 桥的标识，服务才会采用请求里声明的来源（否则一律记为“控制台”）。
      ...(bridge ? { "x-ensemble-client": "mcp" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text}`);
  return json;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const codexOrigin = {
  key: "codex:thread:019f4a1c-7b52-7c3e-9d10-2f6a8e41b0c7",
  kind: "agent",
  host: "codex",
  hostLabel: "Codex",
  sessionRef: { id: "019f4a1c-7b52-7c3e-9d10-2f6a8e41b0c7", kind: "thread", source: "mcp-meta" },
  clientInfo: { name: "codex-mcp-client", version: "0.130.0" },
  workspace: cwd,
  evidence: ["seeded by scripts/dev-seed.mjs"],
};
const cursorOrigin = {
  key: "cursor:conversation:6c0d1e5a-93b4-4f2e-8a7d-1b2c3d4e5f60",
  kind: "agent",
  host: "cursor",
  hostLabel: "Cursor",
  sessionRef: { id: "6c0d1e5a-93b4-4f2e-8a7d-1b2c3d4e5f60", kind: "conversation", source: "mcp-meta" },
  workspace: cwd,
  evidence: ["seeded by scripts/dev-seed.mjs"],
};
const consoleOrigin = { key: "console:local", kind: "user", host: "console", hostLabel: "你（控制台）", workspace: cwd, evidence: [] };

const context = [
  { kind: "text", title: "背景", text: "解析器目前把词法分析和语法分析写在同一个函数里，很难单独测试。目标是拆成 tokenizer 与 AST 两层，对外接口保持不变。" },
  { kind: "file", path: "src/parser/index.ts", note: "现有入口" },
  { kind: "snippet", path: "src/parser/index.ts", language: "ts", startLine: 8, endLine: 16, text: "export function parse(input: string) {\n  const tokens: string[] = [];\n  // … 词法与语法混在一起\n}" },
  { kind: "url", url: "https://example.com/design/parser-split", title: "拆分方案" },
];

const plan = [
  {
    harness: "cursor",
    title: "把解析器拆成 tokenizer 与 AST",
    task: "把 src/parser 里的解析器拆成 tokenizer 和 AST 两层，保持对外接口不变，补齐单元测试，最后运行测试确认全部通过。",
    origin: codexOrigin,
    model: "fixture-deep",
    effort: "high",
    context,
  },
  {
    harness: "pi",
    title: "给仓库接入 vitest",
    task: "[fixture:steps=4] 给仓库接入 vitest，并写好第一个冒烟用例，跑通后汇报。",
    origin: codexOrigin,
  },
  {
    harness: "pi",
    title: "修复 CI 构建失败",
    task: "[fixture:fail] 排查并修复 CI 上 TypeScript 构建失败的问题。",
    origin: codexOrigin,
    access: "read_only",
  },
  {
    harness: "codex",
    title: "整理变更说明",
    task: "[fixture:quick] 把本次改动整理成一段 changelog。",
    origin: cursorOrigin,
  },
  {
    harness: "cursor",
    title: "巡检依赖更新",
    task: "[fixture:long] 持续巡检依赖更新，发现可升级项就汇报。",
    origin: cursorOrigin,
  },
  {
    harness: "codex",
    title: "评估迁移风险",
    task: "[fixture:hold] 评估把构建迁移到 Vite 的风险，先给出方向，等我确认后再往下做。",
    origin: consoleOrigin,
  },
];

const selected = args.has("--minimal") ? [plan[0], plan[1]] : plan;
const created = [];
for (const entry of selected) {
  // 没有经过 MCP 桥、直接调用 HTTP 入口的委派不带来源声明，服务会记为“控制台”。
  const viaBridge = entry.origin !== consoleOrigin;
  const { origin, ...rest } = entry;
  const { sessionId } = await call("POST", "/api/sessions", { cwd, ...rest, ...(viaBridge ? { origin } : {}) }, { bridge: viaBridge });
  created.push({ ...entry, id: sessionId });
  console.log(`+ ${entry.harness.padEnd(6)} ${sessionId}  ${entry.title}`);
  await sleep(450);
}

if (!args.has("--minimal") && !args.has("--no-steer")) {
  const hold = created.find((entry) => entry.task.includes("[fixture:hold]"));
  if (hold) {
    await sleep(2400);
    await call("POST", `/api/sessions/${hold.id}/messages`, { text: "先别动代码，只告诉我最大的两个风险，每个一句话。", mode: "steer" });
    console.log(`→ 已向 ${hold.id} 发送纠偏`);
  }
}

console.log(`\n面板：${info.url}/`);
