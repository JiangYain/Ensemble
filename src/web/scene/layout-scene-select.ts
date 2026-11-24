import { FIT_ALL_MIN_ZOOM, NODE, type Area } from "./layout-geometry";
import { isSlender, planLattice, type Lattice } from "./layout-plan";
import { assemble, type SceneContext } from "./layout-scene-assemble";
import { stacksSingles } from "./layout-stacked";
import { arrange, planClassic, sameClusters, shiftClusters, type Plan } from "./layout-strips";
import { originNodeId, type Assembly } from "./layout-types";

/**
 * 排布的第四步：在摆好的整体上选排法并把它们排列到画布上。
 * 给了取景区域与 `grid`（Overview 的空间视图）走规划式排布：先看经典的树能不能就这样用——放得下缩放上限、又不是细长的竖串、
 * 也不是横屏里单个来源下叠着 3 个以上没有子会话的根会话（`stacksSingles`，见 layout-stacked）——三条都满足就不动它；
 * 否则试格点排布，摆出来核对过才采用：经典排法本来放得下时，格点排布也得放得下缩放上限才换；放不下时要比经典大出超过 1%（见 `tryLattice`）；
 * 其余情况在 1~4 列里选一种摆法。选定之后整体的偏移就直接写进节点位置。
 */

/** 规划用的缩放上限的最大值；与引擎的最大缩放一致（layout 不依赖 engine，所以这里再写一次）。 */
const PLAN_ZOOM_MAX = 1.6;

/** 排布的结果：采用的那一套节点与连线、是否用了格点排布、取景是否要按“全部节点入画”缩。 */
export interface Arrangement {
  readonly chosen: Assembly;
  readonly usedGrid: boolean;
  readonly fitAll: boolean;
}

/** 经典排法的规划，以及判断要不要试格点排布用到的量。 */
interface ClassicPlan {
  readonly fill: Area;
  readonly classic: Plan;
  /** 规划用的缩放上限。 */
  readonly cap: number;
  /** 经典排法在缩放上限 `cap` 下就整个放得进取景区域。 */
  readonly fits: boolean;
}

/** 采用的格点排布：摆出来的那一套、它的规划，以及按真实外框算出的缩放。 */
interface Swap {
  readonly alt: Assembly;
  readonly lattice: Lattice;
  readonly real: number;
}

/** `base` 是按经典的树摆好的一套（见 `assemble`）；格点排法另摆一套，不动它。 */
export function arrangeScene(scene: SceneContext, base: Assembly): Arrangement {
  const { options } = scene;
  const { area } = options;
  const fill = options.grid && area ? area : undefined;
  if (fill && base.clusters.length > 0) return planScene(scene, base, fill);
  arrange(base.clusters, area);
  return { chosen: base, usedGrid: false, fitAll: false };
}

function planScene(scene: SceneContext, base: Assembly, fill: Area): Arrangement {
  const { model } = scene;
  // 规划式排布。先看经典排法能不能在缩放上限 cap 下整个放进取景区域：放得下、外框不是一条细长的竖串、也不是 `stacksSingles` 说的那种竖堆，就不动它（会话少时仍是树）。
  const cap = Math.min(PLAN_ZOOM_MAX, Math.max(FIT_ALL_MIN_ZOOM, scene.options.zoom ?? 1));
  const classic = planClassic(base.clusters, fill, cap);
  let chosen = base;
  let offsets = classic.offsets;
  let scale = classic.scale;
  let usedGrid = false;
  const fits = classic.scale >= cap;
  if (!fits || isSlender({ w: classic.width, h: classic.height }, fill, model.placedCount) || stacksSingles(fill, model.order.length, model.roots, model.children)) {
    const swap = tryLattice(scene, base, { fill, classic, cap, fits });
    if (swap) {
      chosen = swap.alt;
      offsets = swap.lattice.offsets;
      scale = swap.real;
      usedGrid = true;
    }
  }
  shiftClusters(chosen.clusters, offsets);
  // 放不下 100%：取景要缩，按“全部节点入画”缩，别停在可读下限处让用户去滚动。
  return { chosen, usedGrid, fitAll: scale < 1 };
}

/** 规划格点排布、摆出一套全新的节点并核对；可以采用就返回它，没得规划或任何一项对不上就是 undefined（退回经典排法）。 */
function tryLattice(scene: SceneContext, base: Assembly, { fill, classic, cap, fits }: ClassicPlan): Swap | undefined {
  const lattice = planLatticeFor(scene, base, fill);
  if (!lattice) return undefined;
  const alt = assemble(scene, lattice);
  // 摆出来再核对一次：整体的划分与规划时一致、真实的外框也满足要求，才采用；任何一项对不上就退回经典排法。
  // 经典的树本来就放得下（只是细长）时，格点排布也得放得下缩放上限才换；放不下时要明显更大（超过 1%）。
  if (!sameClusters(alt.clusters, base.clusters)) return undefined;
  const right = Math.max(...alt.clusters.map((cluster, i) => lattice.offsets[i]!.x + cluster.width));
  const bottom = Math.max(...alt.clusters.map((cluster, i) => lattice.offsets[i]!.y + cluster.height));
  const real = Math.min(fill.w / right, fill.h / bottom);
  return (fits ? real >= cap : real > classic.scale * 1.01) ? { alt, lattice, real } : undefined;
}

function planLatticeFor(scene: SceneContext, base: Assembly, fill: Area): Lattice | undefined {
  const { dims, model, tree } = scene;
  const byKey = new Map(base.items.map((item) => [item.summary.origin.key, item]));
  return planLattice({
    area: fill,
    compact: dims.compact,
    blocks: model.order.map(({ key }) => ({ key, originId: originNodeId(key) })),
    kidsOf: tree.kidsOf,
    joins: model.joins,
    clusters: base.clusters.map((cluster) => ({
      keys: cluster.keys,
      // 经典排法里 Git、Folder 卡各让出一列（宽 folderW + originGap），格点排布里各让出一格。
      lead: Math.round(cluster.lead / (NODE.folderW + dims.originGap)),
      weight: cluster.keys.reduce((sum, key) => sum + byKey.get(key)!.nodes.length, 0),
    })),
  });
}
