import { describe, expect, it } from "vitest";
import { AURA_PHASE_VARS, auraPhases, auraStyle } from "./aura";

/**
 * 氤氲相位的约束：由会话标识决定（同一个会话永远是同一帧）、落在 (0, 1) 里、各会话互不相同、四条腿彼此无关。
 * 动画本身怎么走在真实浏览器里才看得见，这里只钉相位的来源与取值范围。
 */
describe("会话卡氤氲的起始相位", () => {
  it("同一个会话标识永远得到同一组相位：不依赖随机数，也不依赖调用次序", () => {
    expect(auraPhases("ses_01hx0demo")).toEqual(auraPhases("ses_01hx0demo"));
    expect(auraStyle("ses_01hx0demo")).toEqual(auraStyle("ses_01hx0demo"));
    // 先算别的标识再回来算，结果不变（没有藏着可变状态）。
    const first = auraPhases("ses_a");
    auraPhases("ses_b");
    expect(auraPhases("ses_a")).toEqual(first);
  });

  it("相位落在 [0.001, 0.999]：不是 0（起点帧）也不是 1（与 0 同一帧）", () => {
    for (let i = 0; i < 500; i++) {
      for (const value of auraPhases(`ses_${i.toString(36)}_${i * 7919}`)) {
        expect(value).toBeGreaterThanOrEqual(0.001);
        expect(value).toBeLessThanOrEqual(0.999);
      }
    }
  });

  it("不同会话各在各的位置：标识只差一个字符，四条腿也不会全都一样", () => {
    expect(auraPhases("ses_a")).not.toEqual(auraPhases("ses_b"));
    expect(auraPhases("ses_1")).not.toEqual(auraPhases("ses_2"));
    // 同一个会话的四条腿彼此无关：不是同一个数写了四遍。
    for (const id of ["ses_a", "ses_b", "ses_01hx0demo", "ses_01hx0demo2"]) {
      expect(new Set(auraPhases(id)).size, id).toBeGreaterThan(1);
    }
  });

  it("铺得开：几百个标识里，每条腿都取到了靠近 0 与靠近 1 的相位（不是挤在一个窄区间里）", () => {
    const ids = Array.from({ length: 300 }, (_, i) => `ses_${(i * 2654435761 >>> 0).toString(36)}`);
    for (let leg = 0; leg < 4; leg++) {
      const values = ids.map((id) => auraPhases(id)[leg]!);
      expect(Math.min(...values), `leg ${leg}`).toBeLessThan(0.1);
      expect(Math.max(...values), `leg ${leg}`).toBeGreaterThan(0.9);
    }
  });

  it("行内样式是四个自定义属性，值是三位小数的数（样式表里乘上时长写成 animation-delay）", () => {
    const style = auraStyle("ses_01hx0demo") as Record<string, string>;
    expect(Object.keys(style)).toEqual([...AURA_PHASE_VARS]);
    for (const name of AURA_PHASE_VARS) expect(style[name], name).toMatch(/^0\.\d{3}$/);
    // 样式里写的就是 auraPhases 算出的数。
    expect(AURA_PHASE_VARS.map((name) => Number(style[name]))).toEqual(auraPhases("ses_01hx0demo"));
  });
});
