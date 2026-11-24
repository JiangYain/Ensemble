import { Fragment, memo, useMemo, type ReactNode } from "react";
import { CopyButton } from "../components/ui";
import { useT } from "./useT";

/**
 * 轻量 Markdown：只覆盖执行端输出里常见的子集（段落、标题、列表、引用、表格、代码块、行内格式、链接）。
 * 不使用 innerHTML；链接只放行 http(s)。未闭合的结构按流式输出的中间状态宽容处理。
 */

type Block =
  | { type: "p"; text: string }
  | { type: "h"; level: number; text: string }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; start: number; items: { text: string; children: Block[] }[] }
  | { type: "quote"; blocks: Block[] }
  | { type: "hr" }
  | { type: "table"; head: string[]; rows: string[][] };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function indentOf(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += 4;
    else break;
  }
  return width;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i] ?? "";
    if (ch === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i++;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  return parseLines(lines);
}

function parseLines(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  let paragraph: string[] = [];

  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ type: "p", text: paragraph.join("\n") });
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      i++;
      // 流式输出时围栏可能还没闭合：把剩余内容都当作代码。
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++;
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flush();
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "h", level: (heading[1] ?? "#").length, text: heading[2] ?? "" });
      i++;
      continue;
    }

    if (RULE.test(line) && paragraph.length === 0) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? "")) {
        inner.push((QUOTE.exec(lines[i] ?? "")?.[1]) ?? "");
        i++;
      }
      blocks.push({ type: "quote", blocks: parseLines(inner) });
      continue;
    }

    const next = lines[i + 1];
    if (line.includes("|") && next !== undefined && TABLE_SEP.test(next) && next.includes("-")) {
      flush();
      const head = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").trim() !== "" && (lines[i] ?? "").includes("|")) {
        rows.push(splitRow(lines[i] ?? ""));
        i++;
      }
      blocks.push({ type: "table", head, rows });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      flush();
      const match = (bullet ?? ordered) as RegExpExecArray;
      const baseIndent = (match[1] ?? "").length;
      const isOrdered = Boolean(ordered);
      const start = ordered ? Number(ordered[2]) : 1;
      const items: { text: string; children: Block[] }[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? "";
        const m = BULLET.exec(current) ?? ORDERED.exec(current);
        if (!m || (m[1] ?? "").length !== baseIndent || Boolean(ORDERED.exec(current) && !BULLET.exec(current)) !== isOrdered) break;
        const text = m[3] ?? "";
        const nested: string[] = [];
        i++;
        while (i < lines.length) {
          const following = lines[i] ?? "";
          if (following.trim() === "") {
            // 空行之后如果仍是缩进内容，属于该条目；否则结束。
            const after = lines[i + 1];
            if (after !== undefined && indentOf(after) > baseIndent && after.trim() !== "") {
              nested.push("");
              i++;
              continue;
            }
            break;
          }
          if (indentOf(following) > baseIndent) {
            nested.push(following.slice(Math.min(indentOf(following), baseIndent + 2)));
            i++;
            continue;
          }
          break;
        }
        items.push({ text, children: nested.length > 0 ? parseLines(nested) : [] });
        // 同级条目之间允许一个空行
        if ((lines[i] ?? "").trim() === "" && lines[i + 1] !== undefined) {
          const peek = lines[i + 1] ?? "";
          const pm = BULLET.exec(peek) ?? ORDERED.exec(peek);
          if (pm && (pm[1] ?? "").length === baseIndent) i++;
        }
      }
      blocks.push({ type: "list", ordered: isOrdered, start, items });
      continue;
    }

    paragraph.push(line);
    i++;
  }
  flush();
  return blocks;
}

// ───────────────────────── 行内 ─────────────────────────

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*|__([^\s_](?:[\s\S]*?[^\s_])?)__|(?<![\w*])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![\w*])|(?<![\w_])_([^\s_](?:[^_\n]*?[^\s_])?)_(?![\w_])|~~([^\s~](?:[\s\S]*?[^\s~])?)~~|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>)\]]+[^\s<>)\].,;:!?'"，。；：！？、）】])/g;

function safeHref(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  // matchAll owns its own regex cursor, so recursively rendered emphasis and links
  // cannot reset the cursor of their parent text.
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) out.push(...softBreaks(text.slice(last, match.index), `${keyPrefix}t${key++}`));
    const id = `${keyPrefix}${key++}`;
    if (match[2] !== undefined) {
      out.push(<code key={id}>{match[2].trim() === "" ? match[2] : match[2].replace(/^ (.*) $/, "$1")}</code>);
    } else if (match[3] !== undefined || match[4] !== undefined) {
      out.push(<strong key={id}>{renderInline(match[3] ?? match[4] ?? "", id)}</strong>);
    } else if (match[5] !== undefined || match[6] !== undefined) {
      out.push(<em key={id}>{renderInline(match[5] ?? match[6] ?? "", id)}</em>);
    } else if (match[7] !== undefined) {
      out.push(<del key={id}>{renderInline(match[7], id)}</del>);
    } else if (match[8] !== undefined && match[9] !== undefined) {
      const href = safeHref(match[9]);
      out.push(
        href ? (
          <a key={id} href={href} target="_blank" rel="noreferrer noopener">
            {renderInline(match[8], id)}
          </a>
        ) : (
          <Fragment key={id}>{match[0]}</Fragment>
        ),
      );
    } else if (match[10] !== undefined) {
      const href = safeHref(match[10]);
      out.push(
        href ? (
          <a key={id} href={href} target="_blank" rel="noreferrer noopener">
            {match[10]}
          </a>
        ) : (
          <Fragment key={id}>{match[0]}</Fragment>
        ),
      );
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(...softBreaks(text.slice(last), `${keyPrefix}t${key++}`));
  return out;
}

function softBreaks(text: string, key: string): ReactNode[] {
  const parts = text.split("\n");
  const nodes: ReactNode[] = [];
  parts.forEach((part, index) => {
    if (index > 0) nodes.push(<br key={`${key}b${index}`} />);
    if (part) nodes.push(<Fragment key={`${key}s${index}`}>{part}</Fragment>);
  });
  return nodes;
}

// ───────────────────────── 渲染 ─────────────────────────

function CodeBlock({ lang, text }: { lang: string; text: string }): ReactNode {
  const t = useT();
  const isDiff = lang === "diff" || lang === "patch";
  return (
    <figure className="md-code">
      <figcaption>
        <span className="mono">{lang || t("md.code")}</span>
        <CopyButton value={text} label={t("md.copyCode")} />
      </figcaption>
      <pre>
        <code>
          {isDiff
            ? text.split("\n").map((line, index) => (
                <span key={index} className="md-diff-line" data-kind={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : undefined}>
                  {line}
                  {"\n"}
                </span>
              ))
            : text}
        </code>
      </pre>
    </figure>
  );
}

function renderBlocks(blocks: Block[], keyPrefix: string): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${keyPrefix}${index}`;
    switch (block.type) {
      case "p":
        return <p key={key}>{renderInline(block.text, key)}</p>;
      case "h": {
        const Tag = (`h${Math.min(6, block.level + 2)}` as "h3" | "h4" | "h5" | "h6");
        return <Tag key={key}>{renderInline(block.text, key)}</Tag>;
      }
      case "code":
        return <CodeBlock key={key} lang={block.lang} text={block.text} />;
      case "hr":
        return <hr key={key} />;
      case "quote":
        return <blockquote key={key}>{renderBlocks(block.blocks, key)}</blockquote>;
      case "list": {
        const Tag = block.ordered ? "ol" : "ul";
        return (
          <Tag key={key} {...(block.ordered && block.start !== 1 ? { start: block.start } : {})}>
            {block.items.map((item, itemIndex) => (
              <li key={`${key}.${itemIndex}`}>
                {renderInline(item.text, `${key}.${itemIndex}`)}
                {item.children.length > 0 ? renderBlocks(item.children, `${key}.${itemIndex}.`) : null}
              </li>
            ))}
          </Tag>
        );
      }
      case "table":
        return (
          <div className="md-table" key={key}>
            <table>
              <thead>
                <tr>
                  {block.head.map((cell, cellIndex) => (
                    <th key={cellIndex}>{renderInline(cell, `${key}h${cellIndex}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {block.head.map((_, cellIndex) => (
                      <td key={cellIndex}>{renderInline(row[cellIndex] ?? "", `${key}r${rowIndex}c${cellIndex}`)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }): ReactNode {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <div className="md" data-streaming={streaming ? "" : undefined}>{renderBlocks(blocks, "m")}</div>;
});
