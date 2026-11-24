import { describe, expect, it } from "vitest";
import { fallbackReportName, filenameFromDisposition } from "./api";

describe("filenameFromDisposition：下载文件名取自服务端的 Content-Disposition", () => {
  it("没有这个头：交给调用方用兜底名", () => {
    expect(filenameFromDisposition(null)).toBeUndefined();
    expect(filenameFromDisposition(undefined)).toBeUndefined();
    expect(filenameFromDisposition("")).toBeUndefined();
    expect(filenameFromDisposition("attachment")).toBeUndefined();
  });

  it("RFC 5987 的 filename*：百分号编码的中文标题", () => {
    expect(filenameFromDisposition("attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.md")).toBe("报告.md");
  });

  it("filename* 优先于普通的 filename", () => {
    expect(filenameFromDisposition(`attachment; filename="fallback.md"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.md`)).toBe("报告.md");
  });

  it("带引号与不带引号的 filename 都认", () => {
    expect(filenameFromDisposition('attachment; filename="report.md"')).toBe("report.md");
    expect(filenameFromDisposition("attachment; filename=report.md")).toBe("report.md");
  });

  it("百分号编码不合法时退回普通的 filename", () => {
    expect(filenameFromDisposition(`attachment; filename="ok.md"; filename*=UTF-8''%E0%A4%A.md`)).toBe("ok.md");
  });

  it("文件名是别处给的：路径分隔符与控制字符一律换成下划线，不能带着目录跑出下载目录", () => {
    expect(filenameFromDisposition('attachment; filename="../../etc/passwd"')).toBe("_.._etc_passwd");
    const windows = filenameFromDisposition("attachment; filename*=UTF-8''..%5C..%5Cevil.md");
    expect(windows).toBeDefined();
    expect(windows).not.toMatch(/[\\/]/);
    expect(windows).not.toMatch(/^\./);
    expect(filenameFromDisposition("attachment; filename*=UTF-8''a%0Ab.md")).toBe("a_b.md");
  });

  it("清洗之后什么都不剩（空、只有点）就当没有", () => {
    expect(filenameFromDisposition('attachment; filename=""')).toBeUndefined();
    expect(filenameFromDisposition('attachment; filename="..."')).toBeUndefined();
  });

  it("过长的名字截到 150 个字符", () => {
    const name = filenameFromDisposition(`attachment; filename="${"a".repeat(300)}.md"`);
    expect(name).toHaveLength(150);
  });
});

describe("fallbackReportName：服务端没给文件名时自己起的", () => {
  it("带上范围与会话 id 的前一段，足够在下载目录里区分", () => {
    expect(fallbackReportName("ses_abc", { scope: "tree" })).toBe("ensemble-tree-ses_abc.md");
    expect(fallbackReportName("ses_abc", { scope: "session" })).toBe("ensemble-session-ses_abc.md");
  });

  it("id 里不是字母数字下划线连字符的字符换成下划线，最多取 16 个字符", () => {
    expect(fallbackReportName("ses/../x y", { scope: "session" })).toMatch(/^ensemble-session-[\w-]+\.md$/);
    expect(fallbackReportName("a".repeat(40), { scope: "session" })).toBe(`ensemble-session-${"a".repeat(16)}.md`);
  });
});
