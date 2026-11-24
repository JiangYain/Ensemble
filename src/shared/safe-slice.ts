/**
 * 按 UTF-16 码元数截取文字，但不把一个代理对（emoji 等超出 BMP 的字符，占两个码元）从中间切开。
 *
 * `String.prototype.slice` 只数码元：截点恰好落在代理对中间时会留下一个孤立的代理项，输出里是乱码。
 * 两个函数的语义是固定的约定——随技能分发的 `skills/ensemble-delegate/scripts/watch.mjs` 不能 import 本文件，里面抄了一份同样的写法，
 * 改这里要两边一起改：
 * - `sliceHead(text, n)`：取开头 n 个码元。若下标 n-1 是高位代理（D800–DBFF）且下标 n 是低位代理（DC00–DFFF），只取 n-1 个。
 * - `sliceTail(text, n)`：取结尾 n 个码元，即从下标 s = text.length - n 开始取。若下标 s 是低位代理且下标 s-1 是高位代理，从 s+1 开始取。
 * - 原文里本来就有的孤立代理项原样保留：只在“这一刀把一对切开”时才少取一个，不去修补别处。
 * - n 夹在 [0, 长度] 之内：n ≤ 0 得到空串，n ≥ 长度得到整段。结果最多比要求的少一个码元，不会多，所以“总长度不超过预算”的前提不变。
 * 调用方各自的 `trimEnd` / `trimStart`、省略号、“省略了多少字符”都要在这之后、按实际留下的长度去算。
 */

/** 高位代理：代理对的前一个码元。 */
export function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/** 低位代理：代理对的后一个码元。 */
export function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** 取开头最多 `max` 个码元；截点落在代理对中间时少取一个（把前半个也让出去）。 */
export function sliceHead(text: string, max: number): string {
  let end = Math.min(text.length, Math.max(0, Math.floor(max)));
  // end 与 end-1 都存在、并且恰好是一对：这一刀把它切开了。
  if (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end -= 1;
  return text.slice(0, end);
}

/** 取结尾最多 `max` 个码元；起点落在代理对中间时少取一个（后半个也让出去）。 */
export function sliceTail(text: string, max: number): string {
  const size = Math.min(text.length, Math.max(0, Math.floor(max)));
  let start = text.length - size;
  // start 与 start-1 都存在、并且恰好是一对：这一刀把它切开了。
  if (start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) start += 1;
  return text.slice(start);
}
