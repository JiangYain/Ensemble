import { describe, expect, it } from "vitest";
import {
  dshToolCategory,
  endTool,
  findModel,
  parseCatalog,
  permissionDecision,
  planOf,
  progressTool,
  resultText,
  startTool,
  toModelInfo,
  toolTitle,
  turnErrorInfo,
  turnErrorText,
  usageOf,
  type ToolTrack,
} from "./dsh-events";
import { DshRpcError } from "./dsh-rpc";

// 这里的样例都取自 dsh 0.2.2-rc.1 的真实运行记录（见 dsh-events.ts 开头的说明）。

const CWD = "C:\\work\\proj";
const AT = "2026-11-16T01:00:00.000Z";
const END = "2026-11-16T01:00:01.000Z";

const text = (value: string): unknown => [{ type: "content", content: { type: "text", text: value } }];

function track(name: string, input: Record<string, unknown> | undefined): ToolTrack {
  const started = startTool({ toolCallId: "c1", title: name, kind: "other", status: "in_progress", ...(input ? { rawInput: input } : {}) }, CWD, AT);
  if (!started) throw new Error("startTool returned nothing");
  return started.track;
}

const end = (t: ToolTrack, status: string, body: string, cancelRequested = false) =>
  endTool(t, { toolCallId: t.callId, status, content: text(body) }, { cwd: CWD, at: END, cancelRequested });

describe("工具开始", () => {
  it("shell：标题是命令（折成一行），输入是命令原文", () => {
    const started = startTool(
      { toolCallId: "c_pwsh", title: "pwsh", status: "in_progress", rawInput: { description: "List files", command: "Get-ChildItem `\n  -Recurse" } },
      CWD,
      AT,
    );
    expect(started?.update).toMatchObject({ callId: "c_pwsh", name: "pwsh", category: "shell", title: "Get-ChildItem ` -Recurse", status: "running", startedAt: AT });
    expect(started?.update.input).toMatchObject({ text: "Get-ChildItem `\n  -Recurse", format: "text" });
  });

  it("文件类工具：标题是工作目录内的相对路径（统一正斜杠）", () => {
    expect(toolTitle("write", { file_path: "C:\\work\\proj\\out dir\\hello 中文.txt" }, CWD)).toBe("out dir/hello 中文.txt");
    expect(toolTitle("read", { file_path: "a.txt", offset: 2 }, CWD)).toBe("a.txt");
    expect(toolTitle("edit", {}, CWD)).toBe("edit");
    expect(toolTitle("read", { file_path: "D:\\elsewhere\\x.txt" }, CWD)).toBe("D:/elsewhere/x.txt");
  });

  it("搜索与网络：grep 带目录，glob / web_fetch 用查询词与地址", () => {
    expect(toolTitle("grep", { pattern: "line2", path: "out dir" }, CWD)).toBe("line2 in out dir");
    expect(toolTitle("grep", { pattern: "zzz" }, CWD)).toBe("zzz");
    expect(toolTitle("glob", { pattern: "*.txt" }, CWD)).toBe("*.txt");
    expect(toolTitle("web_fetch", { url: "http://127.0.0.1:1/v1/models" }, CWD)).toBe("http://127.0.0.1:1/v1/models");
    expect(toolTitle("subagent", { description: "Review the diff", prompt: "..." }, CWD)).toBe("Review the diff");
  });

  it("没有字符串参数的工具退回工具名；输入预览是 JSON", () => {
    const started = startTool({ toolCallId: "c_todo", title: "todo_write", rawInput: { todos: [{ content: "a", status: "pending" }] } }, CWD, AT);
    expect(started?.update).toMatchObject({ category: "plan", title: "todo_write" });
    expect(started?.update.input?.format).toBe("json");
  });

  it("edit 的输入预览是只含变化行的 diff（首尾相同的行不算）", () => {
    const started = startTool({ toolCallId: "e", title: "edit", rawInput: { file_path: "a.txt", old_string: "keep\nold line\nend", new_string: "keep\nnew line\nend" } }, CWD, AT);
    expect(started?.update.input).toMatchObject({ text: "-old line\n+new line", format: "diff" });
  });

  it("没有调用标识的更新没法与结束事件对上，直接忽略；没有 title 时名字叫 tool", () => {
    expect(startTool({ title: "read" }, CWD, AT)).toBeUndefined();
    expect(startTool({ toolCallId: "x" }, CWD, AT)?.update).toMatchObject({ name: "tool", category: "other" });
  });

  it("23 个内置工具都有类别", () => {
    const expected: Record<string, string> = {
      read: "read", read_image: "read", write: "write", edit: "edit", grep: "search", glob: "search",
      pwsh: "shell", job_list: "shell", job_output: "shell", job_kill: "shell", web_fetch: "web",
      todo_write: "plan", create_goal: "plan", get_goal: "plan", update_goal: "plan",
      subagent: "task", subagent_fork: "task", send_message: "task", interrupt_agent: "task", list_agents: "task", workflow: "task", skill: "task",
      working_directory: "other",
    };
    for (const [name, category] of Object.entries(expected)) expect(dshToolCategory(name), name).toBe(category);
  });
});

describe("工具结束", () => {
  it("write 新建文件：completed，新增行数来自写入的内容", () => {
    const t = track("write", { file_path: "out dir\\hello.txt", content: "line1\nline2\nline3\n" });
    const done = end(t, "completed", "<path>C:\\work\\proj\\out dir\\hello.txt</path>\n<type>file</type>\n<content>\nCreated file\n</content>");
    expect(done.update).toMatchObject({ callId: "c1", status: "completed", endedAt: END });
    expect(done.files).toEqual([{ path: "out dir/hello.txt", change: "created", addedLines: 3 }]);
  });

  it("write 覆盖已有文件：modified，拿不到旧内容所以不报行数", () => {
    const t = track("write", { file_path: "a.txt", content: "one\nTWO\n" });
    expect(end(t, "completed", "…\nUpdated file\n</content>").files).toEqual([{ path: "a.txt", change: "modified" }]);
  });

  it("edit：modified，增删行数与 diff 来自参数；replace_all 不报行数", () => {
    const single = track("edit", { file_path: "a.txt", old_string: "line2", new_string: "LINE2" });
    expect(end(single, "completed", "The file x has been updated successfully.").files).toEqual([
      { path: "a.txt", change: "modified", addedLines: 1, removedLines: 1, diff: { text: "-line2\n+LINE2", truncated: false, chars: 13, format: "diff" } },
    ]);
    const all = track("edit", { file_path: "a.txt", old_string: "o", new_string: "0", replace_all: true });
    expect(end(all, "completed", "All occurrences were successfully replaced.").files).toEqual([{ path: "a.txt", change: "modified" }]);
  });

  it("失败的写入不产生文件变更；错误取首行并去掉 Error: 前缀", () => {
    const t = track("edit", { file_path: "a.txt", old_string: "NOT-THERE", new_string: "x" });
    const done = end(t, "failed", 'Error: old_string was not found in "C:\\work\\proj\\a.txt"\nsecond line');
    expect(done.update).toMatchObject({ status: "failed", error: 'old_string was not found in "C:\\work\\proj\\a.txt"' });
    expect(done.files).toEqual([]);
  });

  it("pwsh 非零退出码：dsh 仍报 completed，这里记为 failed 并带退出码，输出原样保留", () => {
    const t = track("pwsh", { command: "exit 3" });
    const out = "P=1\r\nsecond line\r\n[stderr]\nto-stderr\r\n[exit code: 3]";
    const done = end(t, "completed", out);
    expect(done.update).toMatchObject({ status: "failed", exitCode: 3, error: "Exit code 3" });
    expect(done.update.output?.text).toBe(out);
    expect(end(track("pwsh", { command: "ok" }), "completed", "fine\n[exit code: 0]").update).toMatchObject({ status: "completed", exitCode: 0 });
  });

  it("取消时 dsh 给被打断的工具补发 tool call aborted：记 cancelled 而不是 failed", () => {
    const t = track("pwsh", { command: "ping -n 60 127.0.0.1" });
    expect(end(t, "failed", "Error: tool call aborted", true).update).toMatchObject({ status: "cancelled" });
    expect(end(t, "failed", "Error: tool call aborted", true).update.error).toBeUndefined();
    // 没人请求取消时同样的文本是真实失败。
    expect(end(t, "failed", "Error: tool call aborted", false).update).toMatchObject({ status: "failed", error: "tool call aborted" });
  });

  it("todo_write 成功后给出完整计划；未知状态当作 pending", () => {
    const t = track("todo_write", { todos: [{ content: "Create file", status: "completed" }, { content: "Verify", status: "in_progress" }, { content: "Report", status: "weird" }, { status: "pending" }] });
    const done = end(t, "completed", "Updated todo list: 1 pending, 1 in progress, 1 completed.");
    expect(done.plan).toEqual([
      { text: "Create file", status: "completed" },
      { text: "Verify", status: "in_progress" },
      { text: "Report", status: "pending" },
    ]);
    expect(end(t, "failed", "Error: nope").plan).toBeUndefined();
    expect(planOf(undefined)).toBeUndefined();
  });

  it("没有输出时不带 output；进度更新只在有文本时才有", () => {
    const t = track("glob", { pattern: "*.nope" });
    expect(endTool(t, { toolCallId: "c1", status: "completed" }, { cwd: CWD, at: END, cancelRequested: false }).update.output).toBeUndefined();
    expect(progressTool(t, { toolCallId: "c1", status: "in_progress" })).toBeUndefined();
    expect(progressTool(t, { toolCallId: "c1", content: text("partial") })).toMatchObject({ callId: "c1", status: "running", output: { text: "partial" } });
    expect(resultText([{ type: "content", content: { type: "text", text: "a" } }, { type: "content", content: { type: "text", text: "b" } }, 7])).toBe("a\nb");
  });
});

describe("用量、错误与授权", () => {
  it("usage_update 只有上下文占用，不编造输入输出 token", () => {
    expect(usageOf({ sessionUpdate: "usage_update", used: 7170, size: 1_000_000 })).toEqual({ contextTokens: 7170, contextWindow: 1_000_000 });
    expect(usageOf({ used: 5 })).toEqual({ contextTokens: 5 });
    expect(usageOf({})).toBeUndefined();
  });

  const failure = (reason: string): DshRpcError => new DshRpcError("session/prompt", -32603, reason);

  it("一轮失败：去掉 dsh 的两层包装，按正文归类", () => {
    expect(turnErrorText("Internal error: turn failed: 401: x")).toBe("401: x");
    expect(turnErrorInfo(failure('Internal error: turn failed: 401: {"message":"Incorrect API key provided"}'))).toMatchObject({
      code: "auth_failed",
      message: '401: {"message":"Incorrect API key provided"}',
      detail: 'Internal error: turn failed: 401: {"message":"Incorrect API key provided"}',
    });
    expect(turnErrorInfo(failure('Internal error: turn failed: 429: {"message":"Rate limit reached"}'))).toMatchObject({ code: "rate_limited", retryable: true });
    expect(turnErrorInfo(failure('Internal error: turn failed: 500: {"message":"The server had an error"}'))).toMatchObject({ code: "provider_unavailable", retryable: true });
  });

  it("没配置密钥：dsh 的原文已经说明怎么补，原样保留", () => {
    const info = turnErrorInfo(
      failure('Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment'),
    );
    expect(info.code).toBe("auth_failed");
    expect(info.message).toContain("store DEEPSEEK_API_KEY");
    expect(info.retryable).toBeUndefined();
  });

  const options = [
    { optionId: "allow-always", name: "Always", kind: "allow_always" },
    { optionId: "allow-once", name: "Allow", kind: "allow_once" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ];

  it("授权请求兜底：Full Access 放行一次，只读拒绝；绝不选 always", () => {
    expect(permissionDecision("full", { options })).toEqual({ allow: true, response: { outcome: { outcome: "selected", optionId: "allow-once" } } });
    expect(permissionDecision("read_only", { options })).toEqual({ allow: false, response: { outcome: { outcome: "selected", optionId: "reject-once" } } });
  });

  it("没有一次性选项时取消请求，而不是退而求其次选 always", () => {
    expect(permissionDecision("full", { options: [options[0]] })).toEqual({ allow: false, response: { outcome: { outcome: "cancelled" } } });
    expect(permissionDecision("read_only", {})).toEqual({ allow: false, response: { outcome: { outcome: "cancelled" } } });
  });
});

describe("模型目录", () => {
  // 真实的默认目录（隔离 DSH_HOME、未改任何配置）。
  const real = [
    {
      id: "model", name: "Model", category: "model", type: "select",
      currentValue: '["deepseek-official","deepseek-v4-flash"]',
      options: [{ group: "deepseek-official", name: "DeepSeek", options: [{ value: '["deepseek-official","deepseek-v4-flash"]', name: "deepseek-v4-flash" }] }],
    },
    {
      id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: "high",
      options: [{ value: "off", name: "Off" }, { value: "low", name: "Low" }, { value: "high", name: "High" }, { value: "max", name: "Max" }],
    },
  ];

  it("解析真实目录：一个模型，四档推理，当前档位 high", () => {
    const catalog = parseCatalog(real);
    expect(catalog.models).toEqual([
      { id: "deepseek-official/deepseek-v4-flash", value: '["deepseek-official","deepseek-v4-flash"]', label: "deepseek-v4-flash", provider: "deepseek-official" },
    ]);
    expect(catalog.current).toBe('["deepseek-official","deepseek-v4-flash"]');
    expect(catalog.efforts).toEqual(["off", "low", "high", "max"]);
    expect(catalog.effort).toBe("high");
  });

  it("分组、平铺两种写法都认；空值档位不算；不是元组的取值保留原样", () => {
    const catalog = parseCatalog([
      {
        id: "model", currentValue: "plain",
        options: [
          { group: "p1", name: "P1", options: [{ value: '["p1","m1"]', name: "m1" }, { value: '["p1","m2"]', name: "m2" }] },
          { value: "plain", name: "Plain Model" },
        ],
      },
      { id: "reasoning_effort", currentValue: "", options: [{ value: "" }, { value: "low" }] },
    ]);
    expect(catalog.models.map((model) => model.id)).toEqual(["p1/m1", "p1/m2", "plain"]);
    expect(catalog.models[2]).toMatchObject({ value: "plain", label: "Plain Model" });
    expect(catalog.models[2]?.provider).toBeUndefined();
    expect(catalog.efforts).toEqual(["low"]);
    expect(catalog.effort).toBeUndefined();
  });

  it("没有模型选项或推理选项时给出空目录，而不是抛错", () => {
    expect(parseCatalog(undefined)).toEqual({ models: [], current: undefined, efforts: [], effort: undefined });
    expect(parseCatalog([{ id: "other" }])).toMatchObject({ models: [], efforts: [] });
  });

  it("按 id、原始取值、唯一的模型名找模型；名字有歧义时不猜", () => {
    const { models } = parseCatalog([
      { id: "model", options: [{ group: "a", options: [{ value: '["a","same"]', name: "same" }, { value: '["a","only"]', name: "only" }] }, { group: "b", options: [{ value: '["b","same"]', name: "same" }] }] },
    ]);
    expect(findModel(models, "a/only")?.id).toBe("a/only");
    expect(findModel(models, '["b","same"]')?.id).toBe("b/same");
    expect(findModel(models, "ONLY")?.id).toBe("a/only");
    expect(findModel(models, "same")).toBeUndefined();
    expect(findModel(models, "nope")).toBeUndefined();
  });

  it("ModelInfo：推理档位与默认档位一起给出", () => {
    const [model] = parseCatalog(real).models;
    expect(toModelInfo(model!, { efforts: ["off", "low", "high", "max"], effort: "high" }, true)).toEqual({
      id: "deepseek-official/deepseek-v4-flash",
      label: "deepseek-v4-flash",
      provider: "deepseek-official",
      efforts: ["off", "low", "high", "max"],
      defaultEffort: "high",
      isDefault: true,
    });
    // 不支持推理档位的模型：没有 efforts，也就没有默认档位。
    expect(toModelInfo(model!, { efforts: [], effort: undefined }, false)).toEqual({ id: "deepseek-official/deepseek-v4-flash", label: "deepseek-v4-flash", provider: "deepseek-official" });
  });
});
