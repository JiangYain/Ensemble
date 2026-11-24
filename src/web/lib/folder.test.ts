import { describe, expect, it } from "vitest";
import { directoryKey, folderName, groupFolders, parentPath } from "./folder";
import { worktreeKey } from "./git";

describe("directoryKey · 目录的身份", () => {
  it("同一个目录的不同写法得到同一个 key，不同的目录不会被抹平", () => {
    const repo = directoryKey("C:\\Users\\alice\\Desktop\\Ensemble");
    expect(repo).toBe("c:/users/alice/desktop/ensemble");
    for (const spelling of ["c:/users/alice/desktop/ensemble", "C:/Users/alice/Desktop/Ensemble/", "C:\\USERS\\alice\\\\Desktop\\Ensemble\\", "\\\\?\\C:\\Users\\alice\\Desktop\\Ensemble", "  C:\\Users\\alice\\Desktop\\Ensemble  "]) {
      expect(directoryKey(spelling), spelling).toBe(repo);
    }
    for (const other of ["C:\\Users\\alice\\Desktop", "C:\\Users\\alice\\Desktop\\Ensemble2", "D:\\Users\\alice\\Desktop\\Ensemble", "C:\\Users\\alice\\Desktop\\Ensemble\\sub"]) {
      expect(directoryKey(other), other).not.toBe(repo);
    }
  });

  it("POSIX 区分大小写，反斜杠是文件名的一部分", () => {
    expect(directoryKey("/home/me/Repo")).not.toBe(directoryKey("/home/me/repo"));
    expect(directoryKey("/home/me/a\\b")).not.toBe(directoryKey("/home/me/a/b"));
    expect(directoryKey("/home/me//repo/")).toBe("/home/me/repo");
  });

  it("没有身份的输入返回空串，不会撞上根目录", () => {
    expect(directoryKey("")).toBe("");
    expect(directoryKey("   ")).toBe("");
    expect(directoryKey("/")).toBe("/");
  });

  it("与 Git 的 worktreeKey 是同一套规范化：一个目录在 Git 节点和 Folder 节点上的身份不会各说各话", () => {
    for (const path of ["C:\\repo", "c:/Repo/", "\\\\server\\share\\Repo", "/home/me/Repo", "C:\\x\\..\\repo", ""]) {
      expect(worktreeKey(path), path).toBe(directoryKey(path));
    }
  });
});

describe("groupFolders · 按真实目录归并来源", () => {
  const REPO = "C:\\Users\\alice\\Desktop\\Ensemble";

  it("写法不同、指的是同一个目录的来源是一组；目录不同就是不同的组；没有目录的来源不属于任何一组", () => {
    const groups = groupFolders(
      new Map([
        ["codex", REPO],
        ["cursor", "c:/users/alice/desktop/ensemble/"],
        ["pi", "C:\\other"],
        ["console", ""],
        ["blank", "   "],
      ]),
    );
    expect(groups).toEqual([
      { key: "c:/other", path: "C:\\other", origins: ["pi"] },
      { key: "c:/users/alice/desktop/ensemble", path: REPO, origins: ["codex", "cursor"] },
    ]);
  });

  it("卡片上写哪一种写法与来源出现的先后无关：结尾没有分隔符的优先，再取字典序最小", () => {
    const entries: [string, string][] = [
      ["a", "c:/users/alice/desktop/ensemble"],
      ["b", "C:/Users/alice/Desktop/Ensemble/"],
      ["c", REPO],
      ["d", "C:\\USERS\\alice\\Desktop\\Ensemble\\\\"],
    ];
    const results = [entries, [...entries].reverse(), [entries[2]!, entries[0]!, entries[3]!, entries[1]!]].map((order) => groupFolders(new Map(order)));
    for (const groups of results) {
      expect(groups).toHaveLength(1);
      expect(groups[0]!.path).toBe(REPO);
      expect(groups[0]!.origins).toEqual(["a", "b", "c", "d"]);
    }
    // 只剩带结尾分隔符的写法：保留来源报告的那种，不替它改写。
    expect(groupFolders(new Map([["x", "C:/Work/Repo/"]]))[0]!.path).toBe("C:/Work/Repo/");
  });

  it("结果按目录 key 排序，与输入的迭代顺序无关", () => {
    const keys = (entries: [string, string][]): string[] => groupFolders(new Map(entries)).map((group) => group.key);
    const entries: [string, string][] = [["a", "C:\\b"], ["b", "C:\\a"], ["c", "D:\\a"], ["d", "/z"]];
    expect(keys(entries)).toEqual(["/z", "c:/a", "c:/b", "d:/a"]);
    expect(keys([...entries].reverse())).toEqual(keys(entries));
  });

  it("一个来源只会出现在一组里；空输入没有组", () => {
    expect(groupFolders(new Map())).toEqual([]);
    const groups = groupFolders(new Map([["only", REPO]]));
    expect(groups).toEqual([{ key: "c:/users/alice/desktop/ensemble", path: REPO, origins: ["only"] }]);
  });
});

describe("folderName / parentPath · 卡片上的两行字", () => {
  it("主行是目录的最后一段，次行是上级路径，沿用来源报告时的分隔符", () => {
    expect(folderName("C:\\Users\\alice\\Desktop\\Ensemble")).toBe("Ensemble");
    expect(parentPath("C:\\Users\\alice\\Desktop\\Ensemble")).toBe("C:\\Users\\alice\\Desktop");
    expect(folderName("/home/me/repo")).toBe("repo");
    expect(parentPath("/home/me/repo")).toBe("/home/me");
    expect(parentPath("C:/Users/alice/repo")).toBe("C:/Users/alice");
  });

  it("结尾的分隔符不影响名字与上级", () => {
    expect(folderName("C:\\a\\b\\")).toBe("b");
    expect(parentPath("C:\\a\\b\\")).toBe("C:\\a");
    expect(parentPath("/a/b//")).toBe("/a");
    expect(parentPath("  /a/b  ")).toBe("/a");
  });

  it("盘符根目录下的目录，上级写盘符根；POSIX 顶层目录，上级写 `/`", () => {
    expect(parentPath("C:\\a")).toBe("C:\\");
    expect(parentPath("C:/a")).toBe("C:/");
    expect(parentPath("/a")).toBe("/");
  });

  it("根目录本身没有上级，名字就写它自己", () => {
    expect(parentPath("C:\\")).toBe("");
    expect(parentPath("/")).toBe("");
    expect(folderName("/")).toBe("/");
    expect(folderName("C:\\")).toBe("C:");
    expect(parentPath("repo")).toBe("");
  });
});
