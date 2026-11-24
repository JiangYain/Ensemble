import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ancestorsOf,
  descendantsOf,
  LINUX_CLK_TCK,
  listLinuxProcesses,
  listMacProcesses,
  listPosixProcesses,
  parseLinuxStat,
  parseMacProcessList,
  procKey,
  type ProcInfo,
} from "./process-list";

// 解析与读取逻辑在任何平台上都能测：Linux 读取用临时目录搭的假 /proc，macOS 读取注入样例 ps 输出。
// 真实系统上的读取只在对应平台上跑（文件末尾），其它平台跳过——Linux 与 macOS 的真实读取至今没有在真实系统上验证过。

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 造一行 /proc/<pid>/stat：第 22 个字段是 starttime，其余字段填 0（第 3 个是状态、第 4 个是 ppid）。共 52 个字段，与真实内核一致。 */
function statLine(pid: number, comm: string, state: string, ppid: number, startTicks: number): string {
  const middle = Array.from({ length: 17 }, () => "0"); // 第 5–21 个字段
  const rest = Array.from({ length: 30 }, () => "0"); // 第 23–52 个字段
  return `${pid} (${comm}) ${[state, ppid, ...middle, startTicks, ...rest].join(" ")}\n`;
}

const BTIME = 1_800_000_000;

/** 搭一个假 /proc：`stat` 文件里有 btime；每个键是 /proc 下的一项，值是它的 stat 内容（undefined = 只有目录、没有 stat 文件，像刚好退出的进程）。 */
function fakeProc(entries: Record<string, string | undefined>, btime = BTIME): string {
  const base = mkdtempSync(join(tmpdir(), "ensemble-fakeproc-"));
  dirs.push(base);
  writeFileSync(join(base, "stat"), `cpu  10 20 30 40\nintr 5\nbtime ${btime}\nprocesses 99\n`);
  for (const [name, stat] of Object.entries(entries)) {
    mkdirSync(join(base, name));
    if (stat !== undefined) writeFileSync(join(base, name, "stat"), stat);
  }
  return base;
}

const SELF = { pid: 4000, ppid: 3000 };
const byPid = (procs: ProcInfo[]): ProcInfo[] => [...procs].sort((a, b) => a.pid - b.pid);

describe("procKey", () => {
  it("有原始起始标记（POSIX）用它，没有（Windows）用创建时间", () => {
    expect(procKey({ pid: 7, ppid: 1, created: 500, name: "x" })).toBe("7@500");
    expect(procKey({ pid: 7, ppid: 1, created: 500, name: "x", startMark: "abc" })).toBe("7@abc");
    // 同一个进程换算出来的创建时间变了（校时），起始标记不变，身份不变。
    expect(procKey({ pid: 7, ppid: 1, created: 99_999, name: "x", startMark: "abc" })).toBe("7@abc");
  });
});

describe("ancestorsOf", () => {
  const proc = (pid: number, ppid: number): ProcInfo => ({ pid, ppid, created: 0, name: `p${pid}` });

  it("沿 ppid 向上找，由近到远，含 init、不含自己", () => {
    expect(ancestorsOf(10, [proc(1, 0), proc(4, 1), proc(5, 4), proc(10, 5), proc(200, 1)])).toEqual([5, 4, 1]);
  });

  it("断链、成环、不在表里都会停下", () => {
    expect(ancestorsOf(99, [])).toEqual([]);
    expect(ancestorsOf(10, [proc(10, 77)])).toEqual([77]);
    // 环（pid 复用造成的陈旧 ppid）：2 的父进程是 3，3 的父进程是 2——已经见过的不再走。
    expect(ancestorsOf(2, [proc(2, 3), proc(3, 2)])).toEqual([3]);
  });

  it("descendantsOf 从 process-list 引用，行为不变", () => {
    expect(descendantsOf(100, [proc(100, 1), proc(110, 100), proc(111, 110), proc(200, 1)]).map((entry) => entry.pid)).toEqual([110, 111]);
  });
});

describe("parseLinuxStat", () => {
  it("取 pid、comm、状态、ppid 与 starttime（第 22 个字段）", () => {
    expect(parseLinuxStat(statLine(1234, "node", "S", 1, 98_765))).toEqual({ pid: 1234, comm: "node", state: "S", ppid: 1, startTicks: 98_765 });
  });

  it("comm 可以含空格与括号：以最后一个右括号为界，括号里的内容原样保留", () => {
    expect(parseLinuxStat(statLine(42, "Web Content", "S", 7, 10))).toMatchObject({ pid: 42, comm: "Web Content", ppid: 7, startTicks: 10 });
    expect(parseLinuxStat(statLine(43, "(sd-pam)", "S", 1, 11))).toMatchObject({ comm: "(sd-pam)", ppid: 1, startTicks: 11 });
    // 恶意的 comm：里面伪造了后面的字段。
    expect(parseLinuxStat(statLine(44, "evil) S 1 (x", "R", 5, 12))).toMatchObject({ pid: 44, comm: "evil) S 1 (x", state: "R", ppid: 5, startTicks: 12 });
  });

  it("状态原样返回（僵尸在读取时才被排除）；很大的 pid 与 ppid 也正常", () => {
    expect(parseLinuxStat(statLine(5, "defunct", "Z", 1, 3))).toMatchObject({ state: "Z" });
    expect(parseLinuxStat(statLine(4_194_304, "big", "S", 4_194_303, 1))).toMatchObject({ pid: 4_194_304, ppid: 4_194_303 });
  });

  it("被截断、字段不够、数字坏了、没有括号都返回 undefined，不抛错", () => {
    expect(parseLinuxStat("")).toBeUndefined();
    expect(parseLinuxStat("123 (node) S 1 123 123")).toBeUndefined();
    expect(parseLinuxStat("123 (node")).toBeUndefined();
    expect(parseLinuxStat("123 node S 1 0 0 0 0")).toBeUndefined();
    expect(parseLinuxStat(statLine(1, "x", "S", 1, 1).replace(/^1 /, "abc "))).toBeUndefined();
    // starttime 之后一个字段都没有：无法确认 starttime 本身没被截断。
    const fields = statLine(1, "x", "S", 1, 55).trim().split(" ");
    const upToStartTime = fields.slice(0, 2 + 20).join(" "); // pid、(comm)、第 3–22 个字段
    expect(parseLinuxStat(upToStartTime)).toBeUndefined();
    expect(parseLinuxStat(fields.slice(0, 2 + 21).join(" "))).toMatchObject({ startTicks: 55 });
    // 状态不是单个字母、ppid 不是数字、数字超出安全整数范围。
    expect(parseLinuxStat(statLine(1, "x", "SS", 1, 1))).toBeUndefined();
    expect(parseLinuxStat(statLine(1, "x", "S", 1, 1).replace(" S 1 ", " S one "))).toBeUndefined();
    expect(parseLinuxStat(statLine(1, "x", "S", 1, 1).replace(/^1 /, "99999999999999999999 "))).toBeUndefined();
  });
});

describe("listLinuxProcesses（假 /proc）", () => {
  const procRoot = (): string =>
    fakeProc({
      "3000": statLine(3000, "bash", "S", 1, 1_000),
      "4000": statLine(4000, "node", "R", 3000, 12_345),
      "4001": statLine(4001, "Web Content", "S", 4000, 12_400),
      "4002": statLine(4002, "defunct", "Z", 4000, 12_500),
      "4003": statLine(4003, "dead", "X", 4000, 12_600),
      "4004": statLine(4004, "old-dead", "x", 4000, 12_700),
      // 读取时刚好退出：目录还在，stat 文件已经没了。
      "4005": undefined,
      // 退出过程中读到半截或空内容。
      "4006": "4006 (half",
      "4007": "",
      // stat 里的 pid 与目录名对不上：不是我们要的那一份。
      "4008": statLine(9999, "x", "S", 1, 1),
      // 不是进程的项。
      self: "",
      sys: undefined,
      "12abc": statLine(12, "x", "S", 1, 1),
    });

  it("列出所有活着的进程；僵尸（Z）与已退出（X / x）的、读取中消失的、内容不完整的都不在表里", async () => {
    const procs = await listLinuxProcesses({ procRoot: procRoot(), self: SELF });
    expect(byPid(procs).map((entry) => [entry.pid, entry.ppid, entry.name, entry.state])).toEqual([
      [3000, 1, "bash", "S"],
      [4000, 3000, "node", "R"],
      [4001, 4000, "Web Content", "S"],
    ]);
  });

  it("创建时间 = btime + starttime / CLK_TCK，再取“最晚可能的时刻”（加上 btime 取整与滴答取整的最大误差）；身份用原始 starttime", async () => {
    const procs = await listLinuxProcesses({ procRoot: procRoot(), self: SELF });
    const node = procs.find((entry) => entry.pid === 4000);
    // 12_345 滴答 = 123.45 秒 = 123_450 毫秒；加 btime 整秒的误差 1000 毫秒与滴答的误差 10 毫秒。
    expect(LINUX_CLK_TCK).toBe(100);
    expect(node?.created).toBe(BTIME * 1000 + 123_450 + 1_000 + 10);
    expect(node?.startMark).toBe("12345");
    expect(procKey(node!)).toBe("4000@12345");

    const fast = await listLinuxProcesses({ procRoot: procRoot(), clockTicks: 1000, self: SELF });
    expect(fast.find((entry) => entry.pid === 4000)?.created).toBe(BTIME * 1000 + 12_345 + 1_000 + 1);
  });

  it("系统时钟跳变（btime 变了）后，同一个进程的 created 变了，身份（起始标记）不变", async () => {
    const entries = { "3000": statLine(3000, "bash", "S", 1, 1_000), "4000": statLine(4000, "node", "R", 3000, 12_345) };
    const before = (await listLinuxProcesses({ procRoot: fakeProc(entries, BTIME), self: SELF })).find((entry) => entry.pid === 4000)!;
    const after = (await listLinuxProcesses({ procRoot: fakeProc(entries, BTIME + 3_600), self: SELF })).find((entry) => entry.pid === 4000)!;
    expect(after.created - before.created).toBe(3_600_000);
    expect(procKey(after)).toBe(procKey(before));
  });

  it("自检：表里没有自己就拒绝，不返回一份不可信的表", async () => {
    await expect(listLinuxProcesses({ procRoot: procRoot(), self: { pid: 9_999, ppid: 3000 } })).rejects.toThrow(/this process \(pid 9999\) is not in the list/);
    // 自己恰好是僵尸或已退出状态：同样不在表里。
    await expect(listLinuxProcesses({ procRoot: procRoot(), self: { pid: 4002, ppid: 4000 } })).rejects.toThrow(/not in the list/);
  });

  it("自检：自己的父进程与 process.ppid 对不上就拒绝", async () => {
    await expect(listLinuxProcesses({ procRoot: procRoot(), self: { pid: 4000, ppid: 3001 } })).rejects.toThrow(/parent as 3000 but it is 3001/);
  });

  it("没有 btime、/proc 不存在：拒绝（上层据此跳过清理并留一条说明）", async () => {
    const base = mkdtempSync(join(tmpdir(), "ensemble-fakeproc-"));
    dirs.push(base);
    writeFileSync(join(base, "stat"), "cpu  1 2 3\n");
    await expect(listLinuxProcesses({ procRoot: base, self: SELF })).rejects.toThrow(/listing processes failed: btime is missing/);
    await expect(listLinuxProcesses({ procRoot: join(base, "nope"), self: SELF })).rejects.toThrow(/listing processes failed/);
  });

  it("除“进程刚好退出”之外的读取错误让整份列表失败：不能把读漏的进程当成已经死了", async () => {
    // 用“stat 是个目录”造一个 ENOENT / ESRCH 之外的读取错误。
    const base = procRoot();
    mkdirSync(join(base, "5000"));
    mkdirSync(join(base, "5000", "stat"));
    await expect(listLinuxProcesses({ procRoot: base, self: SELF })).rejects.toThrow(/listing processes failed/);
  });
});

describe("parseMacProcessList", () => {
  // `ps -axww -o pid=,ppid=,stat=,lstart=,comm=`（LC_ALL=C）的样子：状态列宽度不定，lstart 是五个词，日期个位数时有两个空格。
  const SAMPLE = [
    "  PID  PPID STAT STARTED                  COMMAND",
    "    1     0 Ss   Sat Nov 21 08:00:01 2026 /sbin/launchd",
    "  345     1 S    Sat Nov 21 08:00:09 2026 /usr/libexec/logd",
    " 4121  3999 S    Sun Nov  1 09:05:07 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    " 4200  4121 Z    Sun Nov  1 09:05:09 2026 (chrome)",
    " 4201  4121 Z+   Sun Nov  1 09:05:09 2026 (chrome)",
    " 4300  4121 R+   Mon Dec 14 23:59:59 2026 -zsh",
    "",
    " 4400     1 U    Tue Jan  5 00:00:00 2027 node",
    " 4500     1 Ts   Tue Jan  5 00:00:01 2027 /usr/bin/python3",
  ].join("\n");

  it("路径里有空格的名字完整保留（取最后一个 / 之后的部分）；表头、空行、僵尸（Z / Z+）跳过", () => {
    const procs = parseMacProcessList(SAMPLE);
    expect(procs.map((entry) => [entry.pid, entry.ppid, entry.name, entry.state])).toEqual([
      [1, 0, "launchd", "S"],
      [345, 1, "logd", "S"],
      [4121, 3999, "Google Chrome", "S"],
      [4300, 4121, "-zsh", "R"],
      [4400, 1, "node", "U"],
      [4500, 1, "python3", "T"],
    ]);
  });

  it("lstart 是本地时间、精确到秒：创建时间取“这一秒的最晚时刻”（+999 毫秒），起始标记是数字拼成的、不受空格补位影响", () => {
    const [launchd, , chrome, zsh] = parseMacProcessList(SAMPLE);
    expect(launchd?.created).toBe(new Date(2026, 10, 21, 8, 0, 1).getTime() + 999);
    expect(launchd?.startMark).toBe("2026-11-21 8:00:01");
    // 个位数日期（两个空格）、不同的星期。
    expect(chrome?.created).toBe(new Date(2026, 10, 1, 9, 5, 7).getTime() + 999);
    expect(chrome?.startMark).toBe("2026-11-1 9:05:07");
    expect(zsh?.created).toBe(new Date(2026, 11, 14, 23, 59, 59).getTime() + 999);
    expect(procKey(chrome!)).toBe("4121@2026-11-1 9:05:07");
  });

  it("CRLF 换行也行；对不上格式的行（没有命令、月份不认识、pid 不是数字、日期不全）整行跳过，不抛错", () => {
    const procs = parseMacProcessList(
      [
        "10 1 S Sat Nov 21 08:00:01 2026 ok-one",
        "11 1 S Sat Nov 21 08:00:01 2026",
        "12 1 S Sat Foo 21 08:00:01 2026 bad-month",
        "abc 1 S Sat Nov 21 08:00:01 2026 bad-pid",
        "13 1 S Sat Nov 21 08:00 2026 short-time",
        "14 1 S Sat Nov 21 08:00:01 2026 ok-two",
      ].join("\r\n"),
    );
    expect(procs.map((entry) => entry.pid)).toEqual([10, 14]);
  });

  it("命令以 / 结尾或根本没有 /：名字取整个命令", () => {
    const [slash, bare] = parseMacProcessList(["20 1 S Sat Nov 21 08:00:01 2026 /", "21 1 S Sat Nov 21 08:00:01 2026 kernel_task"].join("\n"));
    expect(slash?.name).toBe("/");
    expect(bare?.name).toBe("kernel_task");
  });
});

describe("listMacProcesses（注入的 ps 输出）", () => {
  const PS = ["    1     0 Ss   Sat Nov 21 08:00:01 2026 /sbin/launchd", " 4121     1 S    Sun Nov  1 09:05:07 2026 /usr/bin/node", " 4300  4121 R+   Mon Dec 14 23:59:59 2026 node"].join("\n");

  it("解析 ps 的输出并返回", async () => {
    const procs = await listMacProcesses({ runPs: async () => PS, self: { pid: 4300, ppid: 4121 } });
    expect(procs.map((entry) => entry.pid)).toEqual([1, 4121, 4300]);
  });

  it("自检：表里没有自己、或自己的父进程对不上，都拒绝", async () => {
    await expect(listMacProcesses({ runPs: async () => PS, self: { pid: 7777, ppid: 1 } })).rejects.toThrow(/not in the list/);
    await expect(listMacProcesses({ runPs: async () => PS, self: { pid: 4300, ppid: 1 } })).rejects.toThrow(/parent as 4121 but it is 1/);
  });

  it("ps 输出格式对不上（一行也解析不出）时拒绝，而不是返回一张空表让上层以为没有进程", async () => {
    await expect(listMacProcesses({ runPs: async () => "ps: illegal option -- w\nusage: ps [-AaCcEefhjlMmrSTvwXx]\n" })).rejects.toThrow(/not in the list/);
  });

  it("ps 跑不起来：错误原样抛出", async () => {
    await expect(
      listMacProcesses({
        runPs: async () => {
          throw new Error("listing processes failed: spawn /bin/ps ENOENT");
        },
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("listPosixProcesses", () => {
  it("不支持的平台直接拒绝（不声称支持，也不返回空表）", async () => {
    for (const platform of ["freebsd", "openbsd", "sunos", "aix", "win32"] as const) {
      await expect(listPosixProcesses(platform)).rejects.toThrow(new RegExp(`${platform} is not supported`));
    }
  });
});

// ───────────────────────── 真实系统（只在对应平台上跑；至今没有在真实系统上验证过） ─────────────────────────

describe.skipIf(process.platform !== "linux")("Linux 真实 /proc", () => {
  it("能列出当前进程：父进程对得上，创建时间与进程自己的运行时长相符，列表里没有僵尸", async () => {
    const all = await listLinuxProcesses();
    const self = all.find((entry) => entry.pid === process.pid);
    expect(self?.ppid).toBe(process.ppid);
    expect(self?.startMark).toMatch(/^\d+$/);
    // 容差放得宽：创建时间是“最晚可能的时刻”（比真实值晚约 1 秒），测试进程活着的这几秒里若遇上休眠或校时也要能过。
    const startedAt = Date.now() - process.uptime() * 1000;
    expect(Math.abs((self?.created ?? 0) - startedAt)).toBeLessThan(60_000);
    expect(descendantsOf(process.ppid, all).some((entry) => entry.pid === process.pid)).toBe(true);
    expect(all.every((entry) => entry.state !== "Z" && entry.state !== "X" && entry.state !== "x")).toBe(true);
  });

  it("listPosixProcesses 在 Linux 上走 /proc", async () => {
    expect((await listPosixProcesses()).some((entry) => entry.pid === process.pid)).toBe(true);
  });
});

describe.skipIf(process.platform !== "darwin")("macOS 真实 ps", () => {
  it("能列出当前进程：父进程对得上，创建时间与进程自己的运行时长相符", async () => {
    const all = await listMacProcesses();
    const self = all.find((entry) => entry.pid === process.pid);
    expect(self?.ppid).toBe(process.ppid);
    expect(self?.startMark).toMatch(/^\d{4}-\d{1,2}-\d{1,2} \d{1,2}:\d{2}:\d{2}$/);
    const startedAt = Date.now() - process.uptime() * 1000;
    expect(Math.abs((self?.created ?? 0) - startedAt)).toBeLessThan(10_000);
    expect(descendantsOf(process.ppid, all).some((entry) => entry.pid === process.pid)).toBe(true);
  });

  it("listPosixProcesses 在 macOS 上跑 ps", async () => {
    expect((await listPosixProcesses()).some((entry) => entry.pid === process.pid)).toBe(true);
  });
});
