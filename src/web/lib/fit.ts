/**
 * 把一段文字排进固定宽度，放不下时在合适的位置省略。
 *
 * 为什么不用 CSS 的 text-overflow: ellipsis：比例字体下它按整个字形截断，盒子比文字多出来的那不足一个字形的宽度
 * 会落在省略号旁边（路径左侧缩进一截，或“…”和尾部之间空出一道），而且没法控制。这里先量，再按字符数精确排。
 *
 * - middle：保留开头 `cut` 个字符，再接“…”，再接末尾 `tail` 个字符（标识符：前缀说明类型，末尾才区分彼此）。
 * - start：隐去开头 `cut` 个字符，前面放“…”，其余原样（路径：末尾的项目名、文件名最重要）。
 *
 * 返回 undefined 表示放得下，不需要省略；否则返回切点。零头宽度（不足一个字符）留在整段文字的末尾，由调用方放到最后。
 */
export type FitMode = { kind: "middle"; tail: number } | { kind: "start" };

export const ELLIPSIS = "…";

/** 量出来的宽度和真实排版之间可能差零点几个像素，留一点余量，宁可少放一个字符，也不要把末尾字形切掉。 */
const SLACK = 0.25;

export function fitCut(chars: readonly string[], available: number, measure: (text: string) => number, mode: FitMode): number | undefined {
  if (!(available > 0) || chars.length === 0) return undefined;
  if (measure(chars.join("")) <= available + 0.01) return undefined;
  const budget = available - SLACK;

  if (mode.kind === "middle") {
    const tail = Math.min(Math.max(mode.tail, 0), chars.length);
    const headMax = chars.length - tail;
    // 末尾已经占满整个值：没有可以省略的部分，交给调用方的 overflow 兜底。
    if (headMax <= 0) return undefined;
    const tailText = chars.slice(chars.length - tail).join("");
    const fits = (head: number): boolean => measure(chars.slice(0, head).join("") + ELLIPSIS + tailText) <= budget;
    // 在 [0, headMax - 1] 里找最大的、放得下的头部长度；连 0 都放不下就只能是 0。
    let low = 0;
    let high = headMax - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  const fits = (cut: number): boolean => measure(ELLIPSIS + chars.slice(cut).join("")) <= budget;
  // 在 [1, length] 里找最小的、放得下的切点；连只剩“…”都放不下就只能是 length。
  let low = 1;
  let high = chars.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) high = mid;
    else low = mid + 1;
  }
  return low;
}
