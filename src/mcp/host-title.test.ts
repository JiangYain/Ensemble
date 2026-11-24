import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Origin } from "@shared/types";
import { readHostRecord, readHostTitle } from "./host-title";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-host-title-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function origin(host: Origin["host"], id: string | undefined, kind: "thread" | "conversation" = "thread", source: "env" | "declared" = "env"): Origin {
  return {
    key: `${host}:${id ?? "bridge"}`,
    kind: "agent",
    host,
    hostLabel: host,
    ...(id ? { sessionRef: { id, kind, source } } : {}),
    evidence: [],
  };
}

describe("Codex 线程标题", () => {
  const THREAD = "01a1d89b-2ad2-7161-999c-fc62a87eca8e";
  const index = (...lines: object[]): void => writeFileSync(join(dir, "session_index.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

  it("按线程 ID 取 thread_name", async () => {
    index({ id: "other", thread_name: "别的线程" }, { id: THREAD, thread_name: "审查 Ensemble 代码质量", updated_at: "2026-11-14T05:50:18Z" });
    expect(await readHostTitle(origin("codex", THREAD), { env: {}, codexHome: dir })).toBe("审查 Ensemble 代码质量");
  });

  it("同一线程改过名时以最后一行为准", async () => {
    index({ id: THREAD, thread_name: "旧名字" }, { id: "other", thread_name: "x" }, { id: THREAD, thread_name: "新名字" });
    expect(await readHostTitle(origin("codex", THREAD), { env: {}, codexHome: dir })).toBe("新名字");
  });

  it("损坏的行和只是名字里碰巧包含这个 ID 的行都不会干扰结果", async () => {
    writeFileSync(
      join(dir, "session_index.jsonl"),
      [`{"id":"${THREAD}","thread_na`, JSON.stringify({ id: "other", thread_name: `提到了 ${THREAD}` }), JSON.stringify({ id: THREAD, thread_name: "真正的标题" })].join("\n"),
    );
    expect(await readHostTitle(origin("codex", THREAD), { env: {}, codexHome: dir })).toBe("真正的标题");
  });

  it("索引里没有这个线程、文件不存在、名字为空时都返回 undefined", async () => {
    index({ id: "other", thread_name: "别的" });
    expect(await readHostTitle(origin("codex", THREAD), { env: {}, codexHome: dir })).toBeUndefined();
    index({ id: THREAD, thread_name: "   " });
    expect(await readHostTitle(origin("codex", THREAD), { env: {}, codexHome: dir })).toBeUndefined();
    expect(await readHostTitle(origin("codex", THREAD), { env: {}, codexHome: join(dir, "missing") })).toBeUndefined();
  });

  it("读 CODEX_HOME 环境变量指向的目录", async () => {
    index({ id: THREAD, thread_name: "来自环境变量" });
    expect(await readHostTitle(origin("codex", THREAD), { env: { CODEX_HOME: dir } })).toBe("来自环境变量");
  });

  it("折叠空白并截断过长的标题", async () => {
    index({ id: THREAD, thread_name: `第一行\n  第二行\t${"很长".repeat(100)}` });
    const title = (await readHostTitle(origin("codex", THREAD), { env: {}, codexHome: dir }))!;
    expect(title.startsWith("第一行 第二行 很长")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("Cursor 对话标题", () => {
  const CONVERSATION = "38ba040b-4d8b-41a4-af34-abd1ce037962";

  /** 照着真实的 state.vscdb 里 composerHeaders 的结构建一个小库：主键 composerId，value 是 JSON（BLOB 或 TEXT 都出现过）。 */
  function cursorDb(rows: { id: string; value: unknown; blob?: boolean }[]): string {
    const file = join(dir, "state.vscdb");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, createdAt INTEGER, value BLOB)");
    const insert = db.prepare("INSERT INTO composerHeaders (composerId, createdAt, value) VALUES (?, ?, ?)");
    for (const row of rows) {
      const json = typeof row.value === "string" ? row.value : JSON.stringify(row.value);
      insert.run(row.id, 1, row.blob === false ? json : new Uint8Array(Buffer.from(json, "utf8")));
    }
    db.close();
    return file;
  }

  it("按对话 ID 取 name（BLOB 与 TEXT 存法都能读）", async () => {
    const cursorDbPath = cursorDb([
      { id: CONVERSATION, value: { name: "Current project overview", subtitle: "Edited a.ts" } },
      { id: "text-row", value: { name: "文本存法" }, blob: false },
    ]);
    expect(await readHostTitle(origin("cursor", CONVERSATION, "conversation"), { env: {}, cursorDb: cursorDbPath })).toBe("Current project overview");
    expect(await readHostTitle(origin("cursor", "text-row", "conversation"), { env: {}, cursorDb: cursorDbPath })).toBe("文本存法");
  });

  it("还没起名（name 为空或缺失）的对话返回 undefined，而不是显示占位文案", async () => {
    const cursorDbPath = cursorDb([
      { id: "nameless", value: { subtitle: "x" } },
      { id: "null-name", value: { name: null } },
      { id: "empty-name", value: { name: "" } },
    ]);
    for (const id of ["nameless", "null-name", "empty-name", "no-such-row"]) {
      expect(await readHostTitle(origin("cursor", id, "conversation"), { env: {}, cursorDb: cursorDbPath })).toBeUndefined();
    }
  });

  it("不是 SQLite 的文件、不存在的库、结构不对的库都返回 undefined", async () => {
    const junk = join(dir, "junk.vscdb");
    writeFileSync(junk, "this is not a database");
    expect(await readHostTitle(origin("cursor", CONVERSATION, "conversation"), { env: {}, cursorDb: junk })).toBeUndefined();
    expect(await readHostTitle(origin("cursor", CONVERSATION, "conversation"), { env: {}, cursorDb: join(dir, "missing.vscdb") })).toBeUndefined();

    const other = join(dir, "other.vscdb");
    const db = new DatabaseSync(other);
    db.exec("CREATE TABLE unrelated (x TEXT)");
    db.close();
    expect(await readHostTitle(origin("cursor", CONVERSATION, "conversation"), { env: {}, cursorDb: other })).toBeUndefined();
  });

  it("库里存的不是合法 JSON 时返回 undefined", async () => {
    const cursorDbPath = cursorDb([{ id: CONVERSATION, value: "{not json", blob: false }]);
    expect(await readHostTitle(origin("cursor", CONVERSATION, "conversation"), { env: {}, cursorDb: cursorDbPath })).toBeUndefined();
  });

  it("Agent 自报的对话标识（宿主没有交出标识时）同样按它取 name，读不到就不显示", async () => {
    const cursorDbPath = cursorDb([{ id: CONVERSATION, value: { name: "Current project overview" } }]);
    expect(await readHostTitle(origin("cursor", CONVERSATION, "conversation", "declared"), { env: {}, cursorDb: cursorDbPath })).toBe("Current project overview");
    // 报了一个库里没有的标识（报错了、或编的）：没有标题，不去猜。
    expect(await readHostTitle(origin("cursor", "4706e0d9-12d7-4b10-a784-5d3416b186a9", "conversation", "declared"), { env: {}, cursorDb: cursorDbPath })).toBeUndefined();
    // 标识只是 SQL 的绑定参数：带引号的字符串既不会报错，也不会多读出别的行。
    expect(await readHostTitle(origin("cursor", "x' OR '1'='1", "conversation", "declared"), { env: {}, cursorDb: cursorDbPath })).toBeUndefined();
  });

  it("只读打开：不会改动宿主的库", async () => {
    const cursorDbPath = cursorDb([{ id: CONVERSATION, value: { name: "标题" } }]);
    await readHostTitle(origin("cursor", CONVERSATION, "conversation"), { env: {}, cursorDb: cursorDbPath });
    const db = new DatabaseSync(cursorDbPath);
    const count = db.prepare("SELECT count(*) AS n FROM composerHeaders").get() as { n: number };
    db.close();
    expect(count.n).toBe(1);
  });

  describe("对话所在的工作区（readHostRecord）", () => {
    /** Windows 上盘符统一成大写（与 cwd、系统各处的写法一致）；别处原样。 */
    const upperDrive = (path: string): string => (process.platform === "win32" ? path.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) : path);
    /** VS Code 系的 fsPath 在 Windows 上盘符是小写（本机 776 行带目录的记录里 770 行是这样）。 */
    const lowerDrive = (path: string): string => (process.platform === "win32" ? path.replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase()) : path);
    const cursor = (id = CONVERSATION, source: "env" | "declared" = "env"): Origin => origin("cursor", id, "conversation", source);

    /** 照着真实的单目录工作区记录写：`workspaceIdentifier: { id, uri: { scheme, fsPath, external, ... } }`。 */
    function folderRow(project: string, extra: object = {}): { id: string; value: unknown } {
      return {
        id: CONVERSATION,
        value: {
          name: "Current project overview",
          workspaceIdentifier: { id: "7d1f0c9a3b", uri: { $mid: 1, fsPath: lowerDrive(project), external: pathToFileURL(project).href, path: "/x", scheme: "file" } },
          ...extra,
        },
      };
    }

    it("取 workspaceIdentifier.uri.fsPath：与标题在同一行，盘符大小写与 cwd 一致", async () => {
      const project = join(dir, "project");
      const cursorDbPath = cursorDb([folderRow(project)]);
      expect(await readHostRecord(cursor(), { env: {}, cursorDb: cursorDbPath })).toEqual({ title: "Current project overview", workspace: upperDrive(project) });
    });

    it("Agent 自报的对话标识同样取它的工作区（来源上有“由 Agent 自报”的注）", async () => {
      const project = join(dir, "project");
      const cursorDbPath = cursorDb([folderRow(project)]);
      expect((await readHostRecord(cursor(CONVERSATION, "declared"), { env: {}, cursorDb: cursorDbPath })).workspace).toBe(upperDrive(project));
    });

    it("fsPath 不是本机的绝对路径时，退而取 external 里的 file URL", async () => {
      const project = join(dir, "project");
      const row = { id: CONVERSATION, value: { workspaceIdentifier: { id: "a", uri: { scheme: "file", fsPath: "relative/project", external: pathToFileURL(project).href } } } };
      expect((await readHostRecord(cursor(), { env: {}, cursorDb: cursorDb([row]) })).workspace).toBe(upperDrive(project));
    });

    it("没有 scheme、external 又是 file URL 时也认；external 不是 file URL 就不认", async () => {
      const project = join(dir, "project");
      const withFileUrl = cursorDb([{ id: CONVERSATION, value: { workspaceIdentifier: { id: "a", uri: { external: pathToFileURL(project).href } } } }]);
      expect((await readHostRecord(cursor(), { env: {}, cursorDb: withFileUrl })).workspace).toBe(upperDrive(project));
      rmSync(withFileUrl);
      const notFile = cursorDb([{ id: CONVERSATION, value: { workspaceIdentifier: { id: "a", uri: { fsPath: project, external: "https://example.com/x" } } } }]);
      expect((await readHostRecord(cursor(), { env: {}, cursorDb: notFile })).workspace).toBeUndefined();
    });

    it("只有 id 的记录（空窗口、多根工作区一类）没有目录可取：不写，而不是猜", async () => {
      const cursorDbPath = cursorDb([{ id: CONVERSATION, value: { name: "无目录", workspaceIdentifier: { id: "fa4cf2d" } } }, { id: "no-field", value: { name: "没有这个字段" } }]);
      expect(await readHostRecord(cursor(), { env: {}, cursorDb: cursorDbPath })).toEqual({ title: "无目录" });
      expect(await readHostRecord(cursor("no-field"), { env: {}, cursorDb: cursorDbPath })).toEqual({ title: "没有这个字段" });
    });

    it("不是 file 方案（远程工作区）的不要：它的 fsPath 是远端机器上的路径", async () => {
      const row = {
        id: CONVERSATION,
        value: { workspaceIdentifier: { id: "r", uri: { scheme: "vscode-remote", authority: "ssh-remote+host", fsPath: join(dir, "remote-looking"), external: "vscode-remote://ssh-remote%2Bhost/home/me/project" } } },
      };
      expect(await readHostRecord(cursor(), { env: {}, cursorDb: cursorDb([row]) })).toEqual({});
    });

    it("相对路径、空串、超过长度上限的目录一律当作没有：不能让它们把委派拖垮", async () => {
      const bad = ["relative/project", "", join(dir, "x".repeat(2_100))];
      for (const fsPath of bad) {
        const row = { id: CONVERSATION, value: { workspaceIdentifier: { id: "a", uri: { scheme: "file", fsPath } } } };
        expect((await readHostRecord(cursor(), { env: {}, cursorDb: cursorDb([row]) })).workspace).toBeUndefined();
        rmSync(join(dir, "state.vscdb"));
      }
    });

    it("末尾分隔符与 .. 段被规整掉", async () => {
      const project = join(dir, "project");
      const sep = process.platform === "win32" ? "\\" : "/";
      const row = { id: CONVERSATION, value: { workspaceIdentifier: { id: "a", uri: { scheme: "file", fsPath: `${lowerDrive(project)}${sep}sub${sep}..${sep}` } } } };
      expect((await readHostRecord(cursor(), { env: {}, cursorDb: cursorDb([row]) })).workspace).toBe(upperDrive(project));
    });

    it("没有对话标识就不查：不按“最近更新的对话”去猜，库里再多记录也不读", async () => {
      const cursorDbPath = cursorDb([folderRow(join(dir, "project"))]);
      expect(await readHostRecord(origin("cursor", undefined), { env: {}, cursorDb: cursorDbPath })).toEqual({});
    });

    it("库读不了（不是 SQLite、不存在、结构不对、JSON 损坏）时返回空对象，不抛错", async () => {
      const junk = join(dir, "junk.vscdb");
      writeFileSync(junk, "this is not a database");
      expect(await readHostRecord(cursor(), { env: {}, cursorDb: junk })).toEqual({});
      expect(await readHostRecord(cursor(), { env: {}, cursorDb: join(dir, "missing.vscdb") })).toEqual({});
      rmSync(junk);
      expect(await readHostRecord(cursor(), { env: {}, cursorDb: cursorDb([{ id: CONVERSATION, value: "{not json", blob: false }]) })).toEqual({});
    });

    it("TEXT 存法同样读得到；只读打开，不改动宿主的库", async () => {
      const project = join(dir, "project");
      const cursorDbPath = cursorDb([{ id: CONVERSATION, value: JSON.stringify({ workspaceIdentifier: { id: "a", uri: { scheme: "file", fsPath: lowerDrive(project) } } }), blob: false }]);
      expect((await readHostRecord(cursor(), { env: {}, cursorDb: cursorDbPath })).workspace).toBe(upperDrive(project));
      const db = new DatabaseSync(cursorDbPath);
      const count = db.prepare("SELECT count(*) AS n FROM composerHeaders").get() as { n: number };
      db.close();
      expect(count.n).toBe(1);
    });

    it("别的宿主不读工作区：Codex 与 Claude Code 的记录里没有这个信息", async () => {
      const id = "0ee8ca57-7685-49b4-ac4b-14c3482d466a";
      writeFileSync(join(dir, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Codex 标题", workspace: join(dir, "project") }));
      expect(await readHostRecord(origin("codex", id), { env: {}, codexHome: dir })).toEqual({ title: "Codex 标题" });
      expect(await readHostRecord(origin("claude", id), { env: {}, claudeHome: join(dir, "missing") })).toEqual({});
    });

    it("readHostTitle 只是 readHostRecord 的标题那一项", async () => {
      const cursorDbPath = cursorDb([folderRow(join(dir, "project"))]);
      expect(await readHostTitle(cursor(), { env: {}, cursorDb: cursorDbPath })).toBe("Current project overview");
    });
  });
});

describe("Claude Code 会话标题", () => {
  const SESSION = "0ee8ca57-7685-49b4-ac4b-14c3482d466a";
  const OTHER = "5b7d5c63-0d94-4fe4-a6cd-b390930521bd";

  /** 照着真实的 ~/.claude/projects/<工作目录>/<会话 ID>.jsonl 的结构写：标题是周期性重复出现的 custom-title 行。 */
  function transcript(project: string, sessionId: string, rows: object[], home = dir): string {
    const folder = join(home, "projects", project);
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `${sessionId}.jsonl`);
    writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    return file;
  }
  const title = (customTitle: string, sessionId = SESSION): object => ({ type: "custom-title", customTitle, sessionId });
  const message = (sessionId = SESSION): object => ({ type: "user", sessionId, message: { role: "user", content: "hi" } });
  const claude = (id: string | undefined = SESSION): Origin => origin("claude", id, "thread");

  it("按会话 ID 找到记录文件，取 custom-title", async () => {
    transcript("C--proj-a", SESSION, [message(), title("项目概览"), message(), title("项目概览")]);
    expect(await readHostTitle(claude(), { env: {}, claudeHome: dir })).toBe("项目概览");
  });

  it("记录文件在任意工作目录的子目录里都能找到，不去算目录名", async () => {
    transcript("C--proj-a", OTHER, [title("别的会话", OTHER)]);
    transcript("some-other-slug-with-中文", SESSION, [title("在另一个目录里")]);
    expect(await readHostTitle(claude(), { env: {}, claudeHome: dir })).toBe("在另一个目录里");
  });

  it("改过名时以最后一行为准；别的会话的行与损坏的行不会干扰", async () => {
    const file = transcript("p", SESSION, [title("旧名字"), message(), title("别人的名字", OTHER), message(), title("新名字")]);
    writeFileSync(file, `${readFileSync(file, "utf8")}{"type":"custom-title","customTitle":"半行`);
    expect(await readHostTitle(claude(), { env: {}, claudeHome: dir })).toBe("新名字");
  });

  it("没起过名（没有 custom-title 行）、没有这个会话、没有 projects 目录时返回 undefined", async () => {
    transcript("p", SESSION, [message(), message()]);
    expect(await readHostTitle(claude(), { env: {}, claudeHome: dir })).toBeUndefined();
    expect(await readHostTitle(claude(OTHER), { env: {}, claudeHome: dir })).toBeUndefined();
    expect(await readHostTitle(claude(), { env: {}, claudeHome: join(dir, "missing") })).toBeUndefined();
    expect(await readHostTitle(claude(undefined), { env: {}, claudeHome: dir })).toBeUndefined();
  });

  it("会话 ID 不是 UUID 时不去拼文件名，避免带路径读到别处", async () => {
    transcript("p", SESSION, [title("不该被读到")]);
    writeFileSync(join(dir, "outside.jsonl"), JSON.stringify({ type: "custom-title", customTitle: "目录之外", sessionId: "../../outside" }));
    for (const id of ["../../outside", "..\\..\\outside", "outside", `${SESSION}/../${SESSION}`]) {
      expect(await readHostTitle(claude(id), { env: {}, claudeHome: dir })).toBeUndefined();
    }
  });

  it("读 CLAUDE_CONFIG_DIR 环境变量指向的目录", async () => {
    transcript("p", SESSION, [title("来自环境变量")]);
    expect(await readHostTitle(claude(), { env: { CLAUDE_CONFIG_DIR: dir } })).toBe("来自环境变量");
  });

  it("超大的记录文件只读开头与结尾：结尾那份标题仍然取得到", async () => {
    const file = join(dir, "projects", "big", `${SESSION}.jsonl`);
    mkdirSync(join(dir, "projects", "big"), { recursive: true });
    // 65 MB 的无关内容夹在开头和结尾的标题之间。
    const filler = `${JSON.stringify({ type: "user", sessionId: SESSION, pad: "x".repeat(1_000_000) })}\n`;
    writeFileSync(file, `${JSON.stringify(title("开头的旧名字"))}\n${filler.repeat(65)}${JSON.stringify(title("结尾的新名字"))}\n`);
    expect(await readHostTitle(claude(), { env: {}, claudeHome: dir })).toBe("结尾的新名字");
  });
});

describe("Pi 会话标题", () => {
  const FILE_ID = "01a1d89b-2ad2-7161-999c-fc62a87eca8e";
  let workspace: string;

  /** Pi 的目录名规则（取自 Pi 源码 getDefaultSessionDirPath）。 */
  const folderFor = (cwd: string): string => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

  beforeEach(() => {
    workspace = join(dir, "work", "project");
    mkdirSync(workspace, { recursive: true });
  });

  /** 写一份会话文件并把修改时间设成 ageMs 之前。 */
  function session(options: { id?: string; cwd?: string; ageMs?: number; names?: string[]; folderCwd?: string }): string {
    const id = options.id ?? FILE_ID;
    const cwd = options.cwd ?? workspace;
    const folder = join(dir, "sessions", folderFor(options.folderCwd ?? cwd));
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `2026-11-14T11-53-16-190Z_${id}.jsonl`);
    const rows: object[] = [
      { type: "session", version: 3, id, timestamp: "2026-11-14T11:53:16.190Z", cwd },
      ...(options.names ?? []).flatMap((name) => [{ type: "session_info", id: "i", parentId: null, timestamp: "t", name }, { type: "message", message: { role: "user" } }]),
    ];
    writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const when = new Date(Date.now() - (options.ageMs ?? 1_000));
    utimesSync(file, when, when);
    return file;
  }
  const pi = (id?: string): Origin => origin("pi", id);
  const read = (extra: object = {}): Promise<string | undefined> => readHostTitle(pi(), { env: {}, piHome: dir, workspace, ...extra });

  it("按工作目录找到最近写过的会话，取最后一个 session_info 的 name", async () => {
    session({ names: ["第一个名字", "后来改的名字"] });
    expect(await read()).toBe("后来改的名字");
  });

  it("不需要会话标识：Pi 的 MCP 进程拿不到它，也不该因此读不到", async () => {
    session({ names: ["有名字"] });
    expect(await readHostTitle(pi(undefined), { env: {}, piHome: dir, workspace })).toBe("有名字");
  });

  it("没传 workspace 时用 origin.workspace；两者都没有就不读", async () => {
    session({ names: ["有名字"] });
    expect(await readHostTitle({ ...pi(), workspace }, { env: {}, piHome: dir })).toBe("有名字");
    expect(await readHostTitle(pi(), { env: {}, piHome: dir })).toBeUndefined();
  });

  it("没起过名的会话返回 undefined，而不是拿第一句话或占位文案顶替", async () => {
    session({ names: [] });
    expect(await read()).toBeUndefined();
  });

  it("目录名的编码规则（原样例取自 Pi 在本机生成的真实目录名，这里换成占位的用户名与项目名）：C:\\Users\\alice\\Desktop\\Project → --C--Users-alice-Desktop-Project--", async () => {
    if (process.platform !== "win32") return;
    const folder = join(dir, "sessions", "--C--Users-alice-Desktop-Project--");
    mkdirSync(folder, { recursive: true });
    const cwd = "C:\\Users\\alice\\Desktop\\Project";
    writeFileSync(join(folder, `2026-08-26T06-37-35-091Z_${FILE_ID}.jsonl`), `${JSON.stringify({ type: "session", id: FILE_ID, cwd })}\n${JSON.stringify({ type: "session_info", name: "真实路径" })}\n`);
    expect(await readHostTitle(pi(), { env: {}, piHome: dir, workspace: "c:\\users\\alice\\desktop\\project\\" })).toBe("真实路径");
  });

  it("最新的会话文件超过 5 分钟没写过就不读（没法说它就是正在调用的这个）", async () => {
    session({ names: ["太久以前"], ageMs: 6 * 60_000 });
    expect(await read()).toBeUndefined();
  });

  it("同一目录下另一个会话在 2 分钟内也写过，分不清就不读", async () => {
    session({ id: "a-session", names: ["甲"], ageMs: 30_000 });
    session({ id: "b-session", names: ["乙"], ageMs: 1_000 });
    expect(await read()).toBeUndefined();
  });

  it("另一个会话早就停了（相隔超过 2 分钟），仍然取最新的那个", async () => {
    session({ id: "old-session", names: ["旧的"], ageMs: 4 * 60_000 });
    session({ id: "new-session", names: ["新的"], ageMs: 1_000 });
    expect(await read()).toBe("新的");
  });

  it("目录名撞车（a\\b-c 与 a-b\\c）时，以文件头里的 cwd 为准，不一致就不读", async () => {
    session({ names: ["别的目录的会话"], cwd: join(dir, "elsewhere"), folderCwd: workspace });
    expect(await read()).toBeUndefined();
  });

  it("目录不存在、没有会话文件、文件头损坏时返回 undefined", async () => {
    expect(await read()).toBeUndefined();
    mkdirSync(join(dir, "sessions", folderFor(workspace)), { recursive: true });
    expect(await read()).toBeUndefined();
    writeFileSync(join(dir, "sessions", folderFor(workspace), "x_y.jsonl"), "not json\n");
    expect(await read()).toBeUndefined();
  });

  it("读 PI_CODING_AGENT_DIR 环境变量指向的目录", async () => {
    session({ names: ["来自环境变量"] });
    expect(await readHostTitle(pi(), { env: { PI_CODING_AGENT_DIR: dir }, workspace })).toBe("来自环境变量");
  });
});

describe("不读的情况", () => {
  it("Agent 自报的会话标识只对 Cursor 读：别的宿主的记录里即便有同一个标识也不读", async () => {
    const id = "0ee8ca57-7685-49b4-ac4b-14c3482d466a";
    writeFileSync(join(dir, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Codex 里同一个标识的标题" }));
    mkdirSync(join(dir, "projects", "p"), { recursive: true });
    writeFileSync(join(dir, "projects", "p", `${id}.jsonl`), JSON.stringify({ type: "custom-title", customTitle: "Claude 里同一个标识的标题", sessionId: id }));
    const options = { env: {}, codexHome: dir, claudeHome: dir };
    // 对照：宿主自己给的标识照常读。
    expect(await readHostTitle(origin("codex", id), options)).toBe("Codex 里同一个标识的标题");
    expect(await readHostTitle(origin("claude", id), options)).toBe("Claude 里同一个标识的标题");
    expect(await readHostTitle(origin("codex", id, "thread", "declared"), options)).toBeUndefined();
    expect(await readHostTitle(origin("claude", id, "conversation", "declared"), options)).toBeUndefined();
  });

  it("没有会话标识、或是没有核对过的宿主，一律不读", async () => {
    const options = { env: {}, codexHome: dir, claudeHome: dir, cursorDb: join(dir, "missing.vscdb") };
    writeFileSync(join(dir, "session_index.jsonl"), JSON.stringify({ id: "sess", thread_name: "不该被读到" }));
    expect(await readHostTitle(origin("codex", undefined), options)).toBeUndefined();
    expect(await readHostTitle(origin("cursor", undefined), options)).toBeUndefined();
    expect(await readHostTitle(origin("claude", undefined), options)).toBeUndefined();
    for (const host of ["vscode", "unknown"] as const) {
      expect(await readHostTitle(origin(host, "sess"), options)).toBeUndefined();
    }
  });
});
