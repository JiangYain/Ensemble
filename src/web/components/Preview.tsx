import { useMemo, type ReactNode } from "react";
import type { Preview as PreviewData } from "@shared/types";
import { useT } from "../lib/useT";
import { CopyButton } from "./ui";

/**
 * 工具输入/输出/差异的预览块。内容就是事件里保存的预览（可能已被截断），截断时明确标出，
 * 不暗示这是完整输出。
 */
export function Preview({ preview, label, maxHeight = 220 }: { preview: PreviewData; label?: string; maxHeight?: number }): ReactNode {
  const t = useT();
  const diff = preview.format === "diff";
  const lines = useMemo(() => (diff ? preview.text.split("\n") : undefined), [diff, preview.text]);
  return (
    <div className="preview">
      {label || preview.text ? (
        <div className="preview-head">
          <span>{label}</span>
          <CopyButton value={preview.text} label={t("preview.copy")} size={12} />
        </div>
      ) : null}
      <pre style={{ maxHeight }} data-scroll>
        <code>
          {lines
            ? lines.map((line, index) => (
                <span key={index} className="md-diff-line" data-kind={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : undefined}>
                  {line}
                  {"\n"}
                </span>
              ))
            : preview.text}
        </code>
      </pre>
      {preview.truncated ? <div className="preview-note">{preview.chars !== undefined ? t("preview.truncatedChars", { n: preview.chars.toLocaleString() }) : t("preview.truncated")}</div> : null}
    </div>
  );
}
