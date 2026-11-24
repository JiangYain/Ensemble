import { useId, type ComponentProps, type CSSProperties, type ReactNode } from "react";

/**
 * 线性图标集（24 网格，1.7 描边，方头线帽、斜接线角）。
 * 少数“实心”图标（停止、点点点、Git 标）单独处理，保证视觉重量一致。
 *
 * 全站没有圆角，图标也一样：
 *   · 线的两端是方头（伸出半个线宽，与原先的圆头同长，图标的整体尺寸不变；长度几乎为 0 的线段 `h.01` 因此画成与线宽等边的小方块，不是圆点）；
 *   · 转角是斜接，夹角太尖（见 MITER_LIMIT）的削成斜面，免得针尖伸出去；
 *   · 轮廓里原先的圆角（文件夹、窗口、键盘、收件箱、插头……）一律是直角；
 *   · 只有曲率本身就是图形的才保留曲线：钟面、刷新弧、放大镜的镜片、地球、眼眶与瞳孔、信息标的圆、齿轮的齿冠，以及人像与手这两个有机的轮廓。
 */

/**
 * 斜接上限：转角的斜接长度 ÷ 线宽（= 1 / sin(夹角 / 2)）超过它就削成斜面。2.2 对应约 54° 以下的夹角：
 * 直角、三角形的角与箭头仍是尖的，闪光、闪电、纸飞机这类 40° 上下的尖头削平（不削的话针尖会比线宽长出一截）。
 * ModelMark.optical.test.tsx 按这个数算占位线图的可见包围盒，改它要重算 ModelMark.tsx 里的光学表。
 */
const MITER_LIMIT = 2.2;

const PATHS = {
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  plus: "M12 5.5v13M5.5 12h13",
  minus: "M5.5 12h13",
  check: "M5.5 12.8l4.2 4.2L18.5 8",
  chevronRight: "M9.5 6l6 6-6 6",
  chevronDown: "M6 9.5l6 6 6-6",
  chevronUp: "M6 14.5l6-6 6 6",
  arrowLeft: "M19 12H5.5M11 6l-6 6 6 6",
  arrowUp: "M12 19V5.5M6 11.5l6-6 6 6",
  arrowDown: "M12 5v13.5M6 12.5l6 6 6-6",
  arrowRight: "M5 12h13.5M13 6l6 6-6 6",
  alert: "M12 4.2l9 15.6H3L12 4.2zM12 10v4.2M12 17.2v.01",
  info: "M12 11v5.5M12 7.5v.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  terminal: "M5 7.5l4.5 4.5L5 16.5M12.5 17H19",
  file: "M7 3.5h6.5L18 8v12.5H7V3.5zM13.5 3.5V8H18",
  edit: "M4.5 19.5l.9-4.1L16.2 4.6l3.2 3.2L8.6 18.6l-4.1.9z",
  search: "M10.8 17.6a6.8 6.8 0 1 0 0-13.6 6.8 6.8 0 0 0 0 13.6zM16 16l4.5 4.5",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.5 12h17M12 3c2.6 2.4 3.9 5.4 3.9 9s-1.3 6.6-3.9 9c-2.6-2.4-3.9-5.4-3.9-9S9.4 5.4 12 3z",
  plug: "M9 3.5v5M15 3.5v5M6.5 8.5h11v8.3h-11zM12 16.8v3.7",
  list: "M9.5 6.5h10.5M9.5 12h10.5M9.5 17.5h10.5M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01",
  sparkle: "M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9L12 3.5zM19 17.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6.6-1.4z",
  folder: "M3.5 5.5h5.6l2 2.2h9.4v11.8h-17z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20c.6-3.6 3.7-6 7.5-6s6.9 2.4 7.5 6",
  // 链接：两个对扣的方括号，中间一道横杠穿过缺口（原先是两节斜放的胶囊形环，端头是半圆）。
  link: "M10 7H6.5v10H10M14 7h3.5v10H14M8.5 12h7",
  copy: "M9 9h10.5v10.5H9V9zM15 9V5.5H4.5V16H9",
  external: "M14 4.5h5.5V10M19.5 4.5L11 13M17.5 14v5.5h-13v-13H10",
  refresh: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.2h-4.2",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5.2l3.2 1.9",
  lock: "M6.5 10.5h11v9h-11v-9zM8.8 10.5V4.8h6.4v5.7",
  flask: "M9.5 3.5h5M10.3 3.5v5.6L5.66 20.6h12.68l-4.64-11.5V3.5M8.1 14.5h7.8",
  layers: "M12 4l8.5 4.7L12 13.4 3.5 8.7 12 4zM3.5 12.6l8.5 4.7 8.5-4.7M3.5 16.4l8.5 4.7 8.5-4.7",
  fit: "M4.5 9.5v-5h5M19.5 9.5v-5h-5M4.5 14.5v5h5M19.5 14.5v5h-5",
  trash: "M5 7h14M9.7 7V4.5h4.6V7M7 7l.9 12.5h8.2L17 7M10.5 11v5M13.5 11v5",
  bot: "M12 4v2.5M4.5 8.5h15v10h-15zM9.2 13.2v1.2M14.8 13.2v1.2",
  // 分支：干线在左；两个节点是 4 见方的方框，占的位置与原先的圆形节点相同（右上的在 x 17–21，左下的在 x 7–11），线接在方框左边的中点；支线是折线，不是曲线。
  branch: "M7 4.5v15M7 15h5V7.5h5M17 5.5h4v4h-4zM7 17.5h4v4H7z",
  send: "M4.5 12l15-7.5-4.8 15-3.2-6.2L4.5 12z",
  pause: "M8.5 6.5v11M15.5 6.5v11",
  play: "M8 5.5l10 6.5-10 6.5v-13z",
  hand: "M8 12V6.8a1.4 1.4 0 0 1 2.8 0V11M10.8 10.5V5.3a1.4 1.4 0 0 1 2.8 0v5.2M13.6 10.5V6.7a1.4 1.4 0 0 1 2.8 0V13c0 4-2.4 6.5-5.6 6.5-2.5 0-3.9-1.2-5-3.2L4 13.6a1.4 1.4 0 0 1 2.4-1.4L8 14",
  keyboard: "M2.5 7h19v10h-19zM6.5 10.5h.01M10 10.5h.01M14 10.5h.01M17.5 10.5h.01M7.5 14h9",
  inbox: "M3.5 13.5l2.74-8h11.52l2.74 8v6h-17zM3.5 13.5h5l1 2h5l1-2h5",
  // 归档 / 取消归档：带盖的方盒，盒身里一道把手（归档）或一支向上的箭头（取消归档）；全是直线。导出（download）是向下的箭头落在一条托线上。
  archive: "M3.5 5.5h17v4h-17zM5.5 9.5v10h13v-10M10 13.5h4",
  unarchive: "M3.5 5.5h17v4h-17zM5.5 9.5v10h13v-10M12 17.5v-6M9 14.5l3-3 3 3",
  download: "M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5M4.5 19.5h15",
  zap: "M13 3.5L5.5 13.5h5.5L10.5 20.5l8-10.5H13l0-6.5z",
  eye: "M2.8 12S6 5.8 12 5.8 21.2 12 21.2 12 18 18.2 12 18.2 2.8 12 2.8 12zM12 14.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2z",
  // eye 的眼眶（同一条曲线）加一道斜线；眼眶在斜线两侧各断开约 2.9（沿 y−x 量），线条之间留出一道缝，15px 下不糊。没有瞳孔：它正好落在斜线上，15px 下只会糊成一团。
  eyeOff: "M14.82 17.72C13.96 18.02 13.02 18.2 12 18.2C6 18.2 2.8 12 2.8 12C2.8 12 3.75 10.16 5.58 8.48M9.18 6.28C10.04 5.98 10.98 5.8 12 5.8C18 5.8 21.2 12 21.2 12C21.2 12 20.25 13.84 18.42 15.52M4.5 4.5l15 15",
  // 对齐与分布：基准线 + 两个长短不同的块；居中类的基准线在块的上下两端断开，不穿过块。
  alignLeft: "M4.5 3.5v17M7.5 5.5h12v5h-12zM7.5 13.5H15v5H7.5z",
  alignHCenter: "M12 3.5v2M12 10.5v3M12 18.5v2M4.5 5.5h15v5h-15zM7.5 13.5h9v5h-9z",
  alignRight: "M19.5 3.5v17M4.5 5.5h12v5h-12zM9 13.5h7.5v5H9z",
  alignTop: "M3.5 4.5h17M5.5 7.5h5v12h-5zM13.5 7.5h5V15h-5z",
  alignVMiddle: "M3.5 12h2M10.5 12h3M18.5 12h2M5.5 4.5h5v15h-5zM13.5 7.5h5v9h-5z",
  alignBottom: "M3.5 19.5h17M5.5 4.5h5v12h-5zM13.5 9h5v7.5h-5z",
  distributeH: "M4.5 4v16M19.5 4v16M9.5 7.5h5v9h-5z",
  distributeV: "M4 4.5h16M4 19.5h16M7.5 9.5h9v5h-9z",
  // 撤销 / 重做：折回的那一段原先是半圆弯，现在是直角的 U 形，起止与包围盒不变（x 到 19.5，y 10.5–20.5）。
  undo: "M9 6L4.5 10.5 9 15M4.5 10.5h15v10H10",
  redo: "M15 6l4.5 4.5L15 15M19.5 10.5h-15v10H14",
  sidebar: "M2.5 5.5h19v13h-19zM9 5.5v13",
  canvas: "M4 9.5h5v5H4zM15 5h5v5h-5zM15 14h5v5h-5zM9 12h3M12 7.5h3M12 16.5h3M12 7.5v9",
  filterLines: "M4 7h16M7 12h10M10 17h4",
  // 齿轮（设置）：六齿，齿顶半径 9、齿根 6.3，齿顶与齿根各是一段圆弧、齿腹是直线，中心一个半径 2.7 的孔。齿数与齿间距按 16px 取：
  // 1.7 的线宽在 16px 下约 1.1px，齿间的缝（齿根处约 1.8px 宽）扣掉描边还剩约 0.7px，八齿以上缝会被描边糊死、整只齿轮成一个圆块。
  settings:
    "M9.95 6.04L10.44 3.14A9 9 0 0 1 13.56 3.14L14.05 6.04A6.3 6.3 0 0 1 16.13 7.25L18.89 6.21A9 9 0 0 1 20.46 8.92L18.18 10.8A6.3 6.3 0 0 1 18.18 13.2L20.46 15.08A9 9 0 0 1 18.89 17.79L16.13 16.75A6.3 6.3 0 0 1 14.05 17.96L13.56 20.86A9 9 0 0 1 10.44 20.86L9.95 17.96A6.3 6.3 0 0 1 7.87 16.75L5.11 17.79A9 9 0 0 1 3.54 15.08L5.82 13.2A6.3 6.3 0 0 1 5.82 10.8L3.54 8.92A9 9 0 0 1 5.11 6.21L7.87 7.25A6.3 6.3 0 0 1 9.95 6.04zM14.7 12a2.7 2.7 0 1 0-5.4 0 2.7 2.7 0 0 0 5.4 0z",
} as const;

export type IconName = keyof typeof PATHS | "more" | "stop" | "dot" | "git";

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
  strokeWidth?: number;
}

/*
 * Git 标（只用在 Git 卡片头部，12.6px，颜色由 marks/brand.css 铺品牌色）：实心菱形（四个角都是尖的），里面镂出一个三节点的分叉。
 *
 * 为什么是实心：旧图标是描边菱形套一个细分支，12.6px 下 1.7 的描边只有 0.89px，三个节点与两条线挤在不到 5px 的方寸里，
 * 1x 下糊成一团“F”，线也比旁边的文字淡得多。菱形的辨识度来自它的整块面积，所以改成实心底、把分叉从里面镂出来
 * ——这是 Git 标在 16px 以下仍然认得出的画法；也和同一格里其他品牌标（实心）同一种语言。与同卡片分支行的 `branch`
 * （灰色、竖线加两个方框）形状、重量、颜色都不一样，不会看成重复。
 *
 * 图形自绘（24 网格）：菱形半对角 10.38、四个角是尖的，墨迹约 10.9px——与原先“半对角 11、圆角 1.5”的版本（圆角把尖端磨掉了 0.62）同样大，
 * 也与更早的描边旧图标的 10.7px 相当，不抬高阅读层级。镂空的线 1.9，三个节点是边长 3.2 的方块，转 45° 与底板同形：
 * 不转的方块角会顶到底板边上（左边两个节点的角离边只剩约 0.5，12.6px 下是半个像素都不到的一道发丝），转 45° 后离边约 1.1。
 * 线宽取 1.9 而不是图标集的 1.7：12.6px 下 1.9 × 12.6/24 ≈ 1.0 CSS px，
 * 1x 下是一整条 1px 的亮线（1.7 只有 0.89px，会发灰），2x 下正好 2 个设备像素。这是唯一偏离 1.7 的地方，只对这个图标。
 * 构图（菱形里一个三节点分叉）沿用 Git 官方标的意象，只有构图，没有它的路径数据；署名与许可见 marks/README.md。
 *
 * 镂空用 mask 而不是 evenodd 复合路径：分叉的线与节点首尾相叠，evenodd 在重叠处会把底色又填回去。
 * mask 切出的是真正的透明，露出卡片自己的底色（选中态的浅蓝头部也一样），不拿背景色去“盖”。
 * 每个实例用 useId 生成自己的 id：同屏有几张 Git 卡就有几个，且 display:none 的父级里引用别处的 mask 会失效。
 *
 * 垂直方向：图形的几何中心在网格 (12, 12)，不做偏移。实测墨迹中心与同行 “Git” 的大写字高中心：1.5x / 2x / 3x 下相差
 * 不到 0.35 CSS px；1x / 1.25x 下文字基线要吸附到整设备像素，差到 0.5–0.8，且各像素比正负不一，不是系统性的“下沉”。
 * 菱形上下是尖角，视觉重心就在几何中心；加一个偏移只会把误差从一个像素比挪到另一个。
 */
const GIT_PLATE = "M12 1.62L22.38 12L12 22.38L1.62 12z";
/** 干线（竖直，两端落在上、下节点中心）+ 支线（从干线下部斜着向上，到右侧节点中心）。 */
const GIT_FORK = "M9.6 7.9v8.2M9.6 14.7L15.4 11.2";
const GIT_NODES = [[9.6, 7.9], [9.6, 16.1], [15.4, 11.2]] as const;
/** 节点方块的边长；以各自的中心转 45°。 */
const GIT_NODE = 3.2;

function GitMark(props: ComponentProps<"svg">): ReactNode {
  const mask = `git-fork-${useId().replace(/:/g, "")}`;
  return (
    <svg {...props} fill="currentColor">
      <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" fill="#fff" />
        <path d={GIT_FORK} fill="none" stroke="#000" strokeWidth="1.9" strokeLinecap="square" />
        {GIT_NODES.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={-GIT_NODE / 2} y={-GIT_NODE / 2} width={GIT_NODE} height={GIT_NODE} transform={`translate(${x} ${y}) rotate(45)`} fill="#000" />
        ))}
      </mask>
      <path d={GIT_PLATE} mask={`url(#${mask})`} />
    </svg>
  );
}

export function Icon({ name, size = 16, className, style, strokeWidth = 1.7 }: IconProps): ReactNode {
  const common = { width: size, height: size, viewBox: "0 0 24 24", className, style, "aria-hidden": true, focusable: false } as const;
  if (name === "more") {
    return (
      <svg {...common} fill="currentColor">
        <rect x="3.8" y="10.3" width="3.4" height="3.4" />
        <rect x="10.3" y="10.3" width="3.4" height="3.4" />
        <rect x="16.8" y="10.3" width="3.4" height="3.4" />
      </svg>
    );
  }
  if (name === "stop") {
    return (
      <svg {...common} fill="currentColor">
        <rect x="6.5" y="6.5" width="11" height="11" />
      </svg>
    );
  }
  if (name === "dot") {
    return (
      <svg {...common} fill="currentColor">
        <rect x="8" y="8" width="8" height="8" />
      </svg>
    );
  }
  if (name === "git") return <GitMark {...common} />;
  return (
    <svg {...common} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="square" strokeLinejoin="miter" strokeMiterlimit={MITER_LIMIT}>
      <path d={PATHS[name]} />
    </svg>
  );
}
