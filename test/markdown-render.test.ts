import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("renders an agent answer with nested Markdown without blocking the page", () => {
  // Run in a child process: a rendering loop must fail this test, not hang the whole suite.
  const text = "## 走查结论\n\n**项目定位**：Ensemble 的 **Cursor `SDK`**，参阅 [项目 *文档*](https://example.com)。\n\n另有 *强调* 和 ~~过时内容~~。";
  const source = `
    import { Window } from "happy-dom";
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    const window = new Window({ url: "http://127.0.0.1:47821/" });
    Object.assign(globalThis, { window, document: window.document, location: window.location,
      localStorage: window.localStorage, sessionStorage: window.sessionStorage });
    const { Markdown } = await import("./src/web/lib/markdown.tsx");
    process.stdout.write(renderToStaticMarkup(createElement(Markdown, { text: ${JSON.stringify(text)} })));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: process.cwd(),
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve("tsconfig.web.json") },
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  expect(result.error?.message ?? result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("<strong>项目定位</strong>：Ensemble");
  expect(result.stdout).toContain("<strong>Cursor <code>SDK</code></strong>");
  expect(result.stdout).toContain('href="https://example.com/"');
  expect(result.stdout).toContain("项目 <em>文档</em>");
  expect(result.stdout).toContain("<em>强调</em>");
  expect(result.stdout).toContain("<del>过时内容</del>");
});
