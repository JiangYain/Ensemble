import type { ReactNode } from "react";
import type { HarnessId } from "@shared/types";
import "../marks/brand.css"; // 品牌标识色层（Git 橙等节点标识色在此，随 harness 标一起全局生效）
import claudeCodeMark from "../marks/claude-code.svg";
import codexMark from "../marks/codex.svg";
import cursorMark from "../marks/cursor.svg";
import dshMark from "../marks/dsh.svg";
import opencodeMark from "../marks/opencode.svg";
import piMark from "../marks/pi.svg";

/**
 * glyph 变体按“可见图形”摆放所需的几何。每枚标的 SVG 自带的留白各不相同（Cursor 的画布是竖版 466.73×532.09，
 * 按 contain 放进正方形后左右各空 6.1%；Pi 的图形只占 800 画布正中的 58.7%；Claude Code 的吉祥物只有 24 画布的 62.5% 高），
 * 按图片框摆，可见的左缘就各偏各的。所以这里记下每枚标渲染后的可见包围盒，摆放以它为准、不以图片框为准：
 *   left / top / width / height  可见包围盒，占“contain 之后的正方形”边长的比例。Cursor、Claude Code、Pi 由路径坐标算出，
 *                                Codex 由 Chrome 把 SVG 画进 2400×2400 画布、取 alpha>0.5 的像素包围盒量出；中性烧瓶是线图，按路径与线宽算（斜接的尖端计入）；
 *   reach                        可见图形的长边占格子（size）的比例，即光学大小：Cursor 的六边形与 Claude Code 的吉祥物
 *                                形状开阔、墨量小，占满格子；Codex 是实心的墨团、Pi 是大块色阶，同样占满会明显更重，收到 22/24。
 *                                格子 24 时，四枚标在白底上可见（非白）的像素面积实测为 276 / 338 / 243 / 303 px²（Cursor / Codex / Claude Code / Pi），
 *                                彼此差在 ±17% 内；若四枚都占满，则是 276 / 403 / 243 / 360，差到 ±25%。
 *                                Codex 的白色 `>_` 画在白色的卡片上，看上去就是镂空，所以只算可见面积 338；连白色 `>_` 一起算的轮廓面积是 360，
 *                                按它算差距是 ±22%——那是把一块看不见的白色当成了墨量。渐变也比旧的纯黑浅得多，Codex 不比从前更重，所以仍是 22/24。
 * 换了 SVG 文件必须重量这些数字（HarnessMark.test.tsx 会按文件里的 viewBox 与路径核对）。
 */
interface Optical {
  left: number;
  top: number;
  width: number;
  height: number;
  reach: number;
}

/** 一枚标的资源与它的光学尺寸是同一个条目的两个必填字段：新增时漏哪一项，都编译不过。 */
export interface HarnessMarkEntry {
  src: string;
  optical: Optical;
}

/**
 * The real harness identities; unknown harnesses get a neutral fallback.
 * 键集合只在这里有一份，且必须是真实的 HarnessId（拼错名字、漏资源、漏光学尺寸都过不了类型检查）；
 * 没有官方标的执行端（模拟端）不在其中，画中性烧瓶（FALLBACK_OPTICAL）。
 * Harness 标保持各家真实的品牌呈现，颜色都写在 SVG 文件里，这里不上色：Pi 与 Claude Code 用官方彩标；
 * Codex 用 Codex 应用自己的蓝紫渐变标（白色 `>_`）——此前误当成官方黑白标，已更正，来源与核实见 marks/README.md；
 * Cursor 的官方品牌包就是黑白立方体，保持黑白，不人为上色——黑白同样是如实呈现，不算缺失。
 * OpenCode 用官方品牌页（opencode.ai/brand）的默认版 logo、浅色背景用的那一枚：内部灰度是墨色的 20% 不透明度，随底色而变；
 * 官方页面明令不得改色、不得填渐变、不得拉伸压扁、不得加投影，所以文件原样放进来、只等比缩放。它是 4:5 的竖版（viewBox 240×300），按 contain 放进正方形后左右各空 10%；
 * 官方规定最小 16×20 px：方格 24 的 glyph 里 reach = 20/24 恰好是 16×20，可见（非白）面积按路径算约 288 px²，落在上面四枚的 243–338 之间；
 * 12 与 16 px 的 bare 小图标低于这个下限，如实记在 marks/README.md。
 * DSH 用 dsh web 应用自己的 favicon（deepseek-ai/deepseek-harness 仓库的 apps/web/public/favicon.svg，浅色版，仓库为 MIT 许可），原样放进来：
 * 它就是 DeepSeek 的鲸鱼标，DSH 没有单独的图形；与 DeepSeek 模型标同形，但模型标另有品牌色（brand.css），不会混成一个。
 * viewBox 是 50×50 的方画布，鲸鱼全由三次贝塞尔曲线构成，可见包围盒按曲线极值算为 0.9668 × 0.7263（Chrome 在 2400×2400 画布上实测一致）；
 * 墨量小：方格 24 里按 reach = 1 画（已是上限），可见面积也只有约 218 px²，是各枚里最轻的，没有再收的余地。来源与条款见 marks/README.md。
 */
export const HARNESS_MARKS = {
  claude: { src: claudeCodeMark, optical: { left: 0, top: 0.1875, width: 1, height: 0.625, reach: 1 } },
  codex: { src: codexMark, optical: { left: 0, top: 0, width: 1, height: 1, reach: 22 / 24 } },
  cursor: { src: cursorMark, optical: { left: 0.0614, top: 0, width: 0.8772, height: 1, reach: 1 } },
  dsh: { src: dshMark, optical: { left: 0.02, top: 0.14, width: 0.9668, height: 0.7263, reach: 1 } },
  opencode: { src: opencodeMark, optical: { left: 0.1, top: 0, width: 0.8, height: 1, reach: 20 / 24 } },
  pi: { src: piMark, optical: { left: 0.2066, top: 0.2066, width: 0.5868, height: 0.5868, reach: 22 / 24 } },
} satisfies Partial<Record<HarnessId, HarnessMarkEntry>>;

/** 只认注册表自己的键：Object.prototype 上的名字（constructor、toString……）不算有标。 */
const isMarked = (harness: string): harness is keyof typeof HARNESS_MARKS => Object.hasOwn(HARNESS_MARKS, harness);

/**
 * 没有官方标的执行端画中性的烧瓶线图（24 画布，线宽 1.6，方头线帽、斜接线角，底角是直角）。
 * 可见包围盒按斜接算：左缘 = 底角外尖（5.78 − 1.17 = 4.61），底缘 = 底边外沿（20.5 + 0.8 = 21.3），上缘 = 瓶口方头（4.5 − 0.8 = 3.7）；
 * 右缘对称（24 − 4.61）。这组包围盒与原先圆角烧瓶的几乎一样（差在 0.002 以内），所以下面的光学表沿用；它是按路径算的，没有在 Chrome 里重新量过。
 */
const FALLBACK_OPTICAL: Optical = { left: 0.1921, top: 0.1542, width: 0.6158, height: 0.7333, reach: 22 / 24 };

export interface HarnessMarkProps {
  harness: HarnessId | string;
  size?: number;
  /**
   * tile：方格里的图标（执行端卡片）；bare：只有图标，没有名字（行内的小图标）；
   * glyph：只有图标，没有框，也没有底色，但带名字（画布上的会话卡）。size 是图标所占的方格，不画出来：
   * 图形按各自的光学大小放进方格，**可见**的左缘贴着方格的左缘，竖向居中——列轴对齐的是图形，不是图片框。
   */
  variant?: "tile" | "bare" | "glyph";
  /** 模拟（fixture）执行端的虚线框（仅 tile）。 */
  simulated?: boolean;
  /** 图标是这个执行端在界面上唯一的身份标记时，用它说出名字：悬停提示与读屏文字（仅 tile 与 glyph）。 */
  tip?: string;
}

export function HarnessMark({ harness, size = 40, variant = "tile", simulated = false, tip }: HarnessMarkProps): ReactNode {
  const mark = isMarked(harness) ? HARNESS_MARKS[harness] : undefined;
  const optical = variant === "glyph" ? (mark?.optical ?? FALLBACK_OPTICAL) : undefined;
  const glyphSize = optical ? (size * optical.reach) / Math.max(optical.width, optical.height) : variant === "tile" ? size * 0.65 : size;
  // 图片框比可见图形大、也比方格大（Pi）：把可见图形的左上角平移到方格的左缘，再让它的中心落在方格竖向的中心。
  const place = optical
    ? { translate: `${-optical.left * glyphSize}px ${(0.5 - optical.top - optical.height / 2) * glyphSize}px` }
    : undefined;
  // glyph 的图片不带 harness-mark：那条类上有 Pi 的放大与 object-fit，都是为方格里的图标写的（见 dock.css 的 .harness-glyph）。
  const glyph = mark ? (
    <img
      className={optical ? undefined : "harness-mark"}
      data-harness={optical ? undefined : harness}
      src={mark.src}
      width={glyphSize}
      height={glyphSize}
      style={place}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  ) : (
    <svg width={glyphSize} height={glyphSize} style={place} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 4.5h6M10 4.5v5.2L5.78 20.5h12.44L14 9.7V4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
  if (variant === "bare") return glyph;
  if (optical) {
    return (
      <span
        className="harness-glyph"
        style={{ width: size, height: size }}
        data-harness={harness}
        data-tip={tip}
        role={tip ? "img" : undefined}
        aria-label={tip}
      >
        {glyph}
      </span>
    );
  }
  return (
    <span
      className="harness-tile"
      style={{ width: size, height: size }}
      data-harness={harness}
      data-sim={simulated ? "" : undefined}
      data-tip={tip}
      role={tip ? "img" : undefined}
      aria-label={tip}
    >
      {glyph}
    </span>
  );
}
