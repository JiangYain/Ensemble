interface Selectable {
  id: string;
  el: HTMLElement | null;
}

/** 选框与选中状态只属于当前画布，不改变会话数据。 */
export class SceneSelection {
  private selected = new Set<string>();
  /** 选中集合的有序快照：只在集合真的变了的时候换成新数组，界面可以直接拿引用比较。 */
  private snapshot: readonly string[] = [];
  private viewport: HTMLElement | undefined;
  private box: HTMLElement | undefined;
  private start: { x: number; y: number; initial: Set<string> } | undefined;
  private onChange: ((count: number) => void) | undefined;

  constructor(private readonly items: () => Iterable<Selectable>) {}

  mount(viewport: HTMLElement, onChange?: (count: number) => void): void {
    this.viewport = viewport;
    this.onChange = onChange;
  }

  unmount(): void {
    this.onChange = undefined;
    this.clear();
    this.box?.remove();
    this.box = undefined;
    this.viewport = undefined;
    this.start = undefined;
  }

  has(id: string): boolean {
    return this.selected.has(id);
  }

  /** 当前选中的节点 id（按选中的先后）。集合不变时返回同一个数组。 */
  list(): readonly string[] {
    return this.snapshot;
  }

  sync(id: string, el: HTMLElement): void {
    el.toggleAttribute("data-selected", this.has(id));
  }

  clear(): void {
    this.set(new Set());
  }

  only(id: string): void {
    this.set(new Set([id]));
  }

  replace(ids: Iterable<string>): void {
    this.set(new Set(ids));
  }

  toggle(id: string): void {
    const next = new Set(this.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.set(next);
  }

  retain(ids: ReadonlySet<string>): void {
    this.set(new Set([...this.selected].filter((id) => ids.has(id))));
  }

  begin(x: number, y: number): void {
    this.start = { x, y, initial: new Set(this.selected) };
  }

  update(x: number, y: number): void {
    const viewport = this.viewport;
    const start = this.start;
    if (!viewport || !start) return;
    const bounds = viewport.getBoundingClientRect();
    const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
    const x1 = clamp(start.x, bounds.left, bounds.left + viewport.clientWidth);
    const y1 = clamp(start.y, bounds.top, bounds.top + viewport.clientHeight);
    const x2 = clamp(x, bounds.left, bounds.left + viewport.clientWidth);
    const y2 = clamp(y, bounds.top, bounds.top + viewport.clientHeight);
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);

    if (!this.box) {
      this.box = document.createElement("div");
      this.box.className = "scene-selection";
      this.box.setAttribute("aria-hidden", "true");
      viewport.appendChild(this.box);
    }
    this.box.hidden = false;
    Object.assign(this.box.style, {
      left: `${left - bounds.left}px`, top: `${top - bounds.top}px`,
      width: `${right - left}px`, height: `${bottom - top}px`,
    });

    const next = new Set(start.initial);
    for (const { id, el } of this.items()) {
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom) next.add(id);
    }
    this.set(next);
  }

  finish(cancelled = false): void {
    if (cancelled && this.start) this.set(this.start.initial);
    this.start = undefined;
    if (this.box) this.box.hidden = true;
  }

  private set(next: Set<string>): void {
    const changed = next.size !== this.selected.size || [...next].some((id) => !this.selected.has(id));
    if (!changed) return;
    this.selected = next;
    this.snapshot = [...next];
    for (const { id, el } of this.items()) if (el) this.sync(id, el);
    this.onChange?.(next.size);
  }
}
