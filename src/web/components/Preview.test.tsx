import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Markdown } from "../lib/markdown";
import { Preview } from "./Preview";

it("wraps long output, diffs and Markdown code without changing their content", () => {
  const text = `${"a_long_identifier_".repeat(25)}\n    indented`;
  const styles = document.createElement("style");
  styles.textContent = readFileSync("src/web/styles/content.css", "utf8");
  document.head.append(styles);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<>
      <Preview preview={{ text, truncated: false, format: "text" }} />
      <Preview preview={{ text: `+${text}`, truncated: false, format: "diff" }} />
      <Markdown text={`\`\`\`ts\n${text}\n\`\`\``} />
    </>));
    const blocks = [...host.querySelectorAll(".preview pre, .md-code pre")];
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      const computed = getComputedStyle(block);
      expect(computed.whiteSpace).toBe("pre-wrap");
      expect(computed.getPropertyValue("overflow-wrap")).toBe("anywhere");
    }
    expect(blocks[0]?.textContent).toBe(text);
    expect(blocks[1]?.textContent).toBe(`+${text}\n`);
    expect(blocks[2]?.textContent).toBe(text);
    expect(host.querySelector('.md-diff-line[data-kind="add"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
    styles.remove();
    vi.unstubAllGlobals();
  }
});
