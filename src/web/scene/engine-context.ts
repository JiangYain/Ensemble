import type { Body } from "./engine-body";
import type { NodeContextHandler, NodeContextRequest } from "./engine-types";
import type { SceneSelection } from "./selection";

/** 右键处理向引擎问的几件事（它不认识引擎本身）。 */
export interface ContextPorts {
  bodies: ReadonlyMap<string, Body>;
  selection: Pick<SceneSelection, "list" | "only">;
  /** 正在拖动、框选或平移。 */
  dragging(): boolean;
}

/**
 * 右键（以及键盘上的 ContextMenu 键、Shift+F10）：引擎先判断菜单的作用范围，再问登记的处理者要不要接管。
 * 两个事件处理函数由输入层挂到窗口与视口上；这里只管判断，不管挂载。
 */
export class NodeContexts {
  private readonly handlers = new Set<NodeContextHandler>();
  /** 刚按下的是 ContextMenu 键或 Shift+F10：紧随其后的 contextmenu 事件来自键盘，坐标不可信。 */
  private keyboard = false;

  constructor(private readonly ports: ContextPorts) {}

  /** 登记一个处理者；返回退订函数。处理者按登记的先后被问，第一个返回 true 的接管。 */
  add(handler: NodeContextHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** 任何指针操作都说明接下来的 contextmenu 不再是键盘来的；卸载时也清掉。 */
  reset(): void {
    this.keyboard = false;
  }

  readonly onKey = (event: KeyboardEvent): void => {
    this.keyboard = event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
  };

  /**
   * 右键与键盘上的“上下文菜单”。只有处理者明确接管时才拦下浏览器的原生菜单；
   * 右键从不移动节点、不打开会话（pointerdown 里按键 2 直接忽略，也不会产生 click）。
   */
  readonly onMenu = (event: MouseEvent): void => {
    // 键盘触发时 Chrome 与 Firefox 给的坐标不一致，有的干脆是 (0,0)：这时不用坐标。
    const fromKeyboard = this.keyboard || (event.button === 0 && event.clientX === 0 && event.clientY === 0);
    this.keyboard = false;
    if (event.defaultPrevented || this.handlers.size === 0) return;
    // macOS 上 Ctrl+点击也会触发 contextmenu：在画布上它是“平移”手势（见 onPointerDown），不是右键，原样放行。
    if (!fromKeyboard && event.button === 0 && event.ctrlKey) return;
    // 正在拖动、框选或平移的时候不弹菜单。
    if (this.ports.dragging()) return;
    const target = event.target instanceof Element ? event.target : undefined;
    const id = target?.closest<HTMLElement>("[data-node-id]")?.dataset["nodeId"];
    const body = id === undefined ? undefined : this.ports.bodies.get(id);
    if (!body?.placed || !body.el) return;

    const selected = this.ports.selection.list();
    const scope = selected.length >= 2 && selected.includes(body.id) ? "selection" : "node";
    const request: NodeContextRequest = {
      nodeId: body.id,
      el: body.el,
      scope,
      ids: scope === "selection" ? selected : [body.id],
      point: fromKeyboard ? undefined : { x: event.clientX, y: event.clientY },
    };
    let handled = false;
    for (const handler of [...this.handlers]) {
      if (handler(request)) {
        handled = true;
        break;
      }
    }
    if (!handled) return;
    event.preventDefault();
    // 右键落在多选集合之外、并且确实为它开了菜单：选中集合变成它。
    // 这样菜单的对象与画布上高亮的对象始终是同一个，多选里的其他节点不会被误当成菜单的作用范围。
    if (scope === "node" && selected.length >= 2) this.ports.selection.only(body.id);
  };
}
