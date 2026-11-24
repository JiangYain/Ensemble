/**
 * 可排序的 ULID 风格标识（浏览器与 Node 均可用）。
 * 同一毫秒内单调递增，保证按字典序即为创建顺序。
 */

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

let lastTime = -1;
let lastRandom: number[] = [];

function randomDigits(): number[] {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  // 80 bit 随机数，拆成 16 个 5 bit 数字。
  const digits: number[] = [];
  for (let i = 0; i < 16; i++) digits.push((bytes[i] ?? 0) & 31);
  return digits;
}

function encodeTime(time: number): string {
  let out = "";
  let t = time;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    // 同一毫秒：随机部分自增，避免乱序。
    const next = [...lastRandom];
    for (let i = next.length - 1; i >= 0; i--) {
      const value = next[i] ?? 0;
      if (value < 31) {
        next[i] = value + 1;
        break;
      }
      next[i] = 0;
    }
    lastRandom = next;
  } else {
    lastTime = now;
    lastRandom = randomDigits();
  }
  return encodeTime(now) + lastRandom.map((d) => ALPHABET[d]).join("");
}

export type IdPrefix = "ses" | "run" | "msg" | "evt" | "ntc" | "req" | "cnn" | "qst";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

export function shortId(id: string, length = 6): string {
  const index = id.indexOf("_");
  const body = index >= 0 ? id.slice(index + 1) : id;
  return body.slice(-length);
}
