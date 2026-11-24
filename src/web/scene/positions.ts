/** User-arranged positions stay local to the browser and never change a session. */
export interface NodePosition {
  x: number;
  y: number;
}

const ALL_KEY = "ensemble.canvas.positions.v1";
const SPACE_PREFIX = "ensemble.canvas.positions.v2:";

function storageKey(spaceKey?: string): string {
  return !spaceKey || spaceKey === "all" ? ALL_KEY : `${SPACE_PREFIX}${spaceKey}`;
}

export function readPositions(spaceKey?: string): Map<string, NodePosition> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey(spaceKey)) ?? "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return new Map();
    return new Map(
      Object.entries(saved).flatMap(([id, value]) => {
        if (!/^(agent|origin|git|folder):/.test(id) || !value || typeof value !== "object") return [];
        const { x, y } = value as Partial<NodePosition>;
        return typeof x === "number" &&
          Number.isFinite(x) &&
          Math.abs(x) < 1_000_000 &&
          typeof y === "number" &&
          Number.isFinite(y) &&
          Math.abs(y) < 1_000_000
          ? [[id, { x, y }]]
          : [];
      }),
    );
  } catch {
    return new Map();
  }
}

export function savePositions(positions: ReadonlyMap<string, NodePosition>, spaceKey?: string): void {
  const key = storageKey(spaceKey);
  try {
    if (positions.size) localStorage.setItem(key, JSON.stringify(Object.fromEntries(positions)));
    else localStorage.removeItem(key);
  } catch {
    // Private browsing may deny storage; dragging still works for this visit.
  }
}
