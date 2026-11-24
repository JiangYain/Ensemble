/**
 * `engine.characterize.*.test.ts` 共用的小工具，仅供测试使用（没有任何运行时代码引用它）：只有构造器和读取函数，不含断言，也不依赖 vitest。
 * 这些测试把拆分之前的引擎行为原样固定下来（拆文件是纯结构整理，行为一个字节都不许变），所以断言里的数值都是旧实现跑出来的结果。
 */

import type { SceneRig } from "./engine.fixtures";

export interface WheelInit {
  deltaX?: number;
  deltaY?: number;
  deltaMode?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  clientX?: number;
  clientY?: number;
}

/** happy-dom 的 WheelEvent 会丢掉修饰键与坐标：事件造出来之后把这些字段补在实例上（引擎读的就是它们）。 */
export function wheelEvent(init: WheelInit = {}): WheelEvent {
  const { ctrlKey = false, metaKey = false, shiftKey = false, clientX = 0, clientY = 0, ...rest } = init;
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...rest });
  Object.defineProperties(event, {
    ctrlKey: { value: ctrlKey },
    metaKey: { value: metaKey },
    shiftKey: { value: shiftKey },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  return event;
}

/** 在目标上滚一下，返回事件（调用方看 `defaultPrevented`）。 */
export function wheel(target: Element, init: WheelInit = {}): WheelEvent {
  const event = wheelEvent(init);
  target.dispatchEvent(event);
  return event;
}

export function key(type: "keydown" | "keyup", init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

/** 节点元素此刻 `translate` 里的两个数。 */
export const spot = (rig: SceneRig, id: string): [number, number] => {
  const [x, y] = rig.els.get(id)!.style.translate.split(" ").map((part) => Number.parseFloat(part));
  return [x!, y!];
};

/** 世界层此刻的相机（`transform` 里的三个数）。 */
export function worldCamera(world: HTMLElement): { x: number; y: number; k: number } {
  const found = /translate3d\((-?[\d.]+)px,(-?[\d.]+)px,0\) scale\(([\d.]+)\)/.exec(world.style.transform);
  if (!found) throw new Error(`世界层没有相机：${world.style.transform}`);
  return { x: Number(found[1]), y: Number(found[2]), k: Number(found[3]) };
}

/** 监听器登记的一行记录：`window.add keydown capture`、`viewport.add wheel passive:false`…… */
export function describeListener(target: string, verb: "add" | "remove", type: string, options: unknown): string {
  const flag = options === true ? " capture" : options && typeof options === "object" ? ` ${JSON.stringify(options)}` : "";
  return `${target}.${verb} ${type}${flag}`;
}
