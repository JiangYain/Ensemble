import type { CSSProperties, ReactNode } from "react";
import "../marks/brand.css"; // 品牌标识色层：各家族的官方色与渐变在这里铺（黑白家族保持中性墨色），来源见 marks/README.md
import claude from "../marks/models/claude.svg";
import composer from "../marks/models/composer.svg";
import deepseek from "../marks/models/deepseek.svg";
import gemini from "../marks/models/gemini.svg";
import glm from "../marks/models/glm.svg";
import grok from "../marks/models/grok.svg";
import kimi from "../marks/models/kimi.svg";
import llama from "../marks/models/llama.svg";
import minimax from "../marks/models/minimax.svg";
import mistral from "../marks/models/mistral.svg";
import openai from "../marks/models/openai.svg";
import qwen from "../marks/models/qwen.svg";
import type { ModelFamily } from "../lib/modelFamily";
import { Icon } from "./Icons";

/**
 * ModelSlot 按“可见图形”摆放所需的几何。十二个家族的 SVG 都是 24×24 的画布，但图形各占各的：Claude 的星芒顶满，
 * Llama 的无穷环只有 2/3 高，Kimi 与 Composer 左边空着一块；按图片框摆，可见的左缘就各偏各的、大小也各不相同。
 * 所以这里记下每枚标渲染后的可见包围盒，摆放以它为准、不以图片框为准：
 *   left / top / width / height  可见包围盒，占画布（遮罩 contain 之后的正方形）边长的比例；
 *                                由 Chrome 把 SVG 画进 2400×2400 画布、取 alpha>0.5 的像素包围盒量出；
 *   reach                        可见图形长边占格子（size）的比例，即光学大小，取整像素的长边（格子 24 时 n/24）。
 * 光学大小按“可见面积”定，而不是一律占满：格子 24 时，十二枚标在满格（长边 24）下的面积（单位 px²，下同）是
 *   grok 130 · minimax 158 · llama 174 · kimi 195 · gemini 203 · deepseek 213 · openai 213 · claude 229 · mistral 235 · glm 240 · composer 273 · qwen 287，
 * 差到 2.2 倍。开阔的标（grok、minimax、llama）占满，仍是最轻的三枚；实心的标收一点（qwen 长边 19、composer 20、glm 与 mistral 21、
 * claude、deepseek、openai 22、gemini 与 kimi 23），都落在 185 上下。收完之后实际面积是
 *   grok 130 · minimax 158 · llama 174 · deepseek 179 · kimi 179 · openai 179 · qwen 180 · mistral 180 · glm 184 · gemini 187 · composer 189 · claude 192，
 * 最大 / 最小 1.48，除 grok 以外都在 159–192 之间（均值 179 的 −11% ~ +7%）。grok 本来就是细线条的开放标（一个环），满格也只有 130，
 * 再放大就越过格子，宁可它轻。
 * 面积是 Chrome 的 alpha 之和（含抗锯齿），ModelMark.optical.test.tsx 用路径自己的扫描线面积复核，与 Chrome 差在千分之一内。
 * 换了 SVG 文件必须重量这张表：那个测试按文件里的路径核对包围盒与面积，不对就会红。
 *   hang                         可选。左缘那一段若是比 1px 还细的发丝，对齐的就该是主体而不是发丝尖：grok 的环带着两条尾巴（左下、右上），
 *                                左下的尾尖在包围盒左缘，环体在它右边 3.36px（占边长 0.14）；按尾尖对齐，眼睛看到的环体左缘落在 x=17，
 *                                与同一张卡头部的执行端图标（x=14）差 3px。hang 把图形再向左挪这一段，环体贴着列轴，尾巴像标点一样悬在外面
 *                                （覆盖率不到一半，24px 下几乎看不见）。其余家族没有这种发丝，不设。
 */
export interface Optical {
  left: number;
  top: number;
  width: number;
  height: number;
  reach: number;
  hang?: number;
}

/** 注册表：资源与光学大小是同一个条目的两个必填字段，新增家族漏一项在 tsc 就过不了。 */
export interface ModelMarkEntry {
  src: string;
  optical: Optical;
}

export const MODEL_MARKS: Record<ModelFamily, ModelMarkEntry> = {
  claude: { src: claude, optical: { left: 0, top: 0, width: 1, height: 1, reach: 22 / 24 } },
  composer: { src: composer, optical: { left: 0.0612, top: 0, width: 0.8775, height: 1, reach: 20 / 24 } },
  deepseek: { src: deepseek, optical: { left: 0, top: 0.125, width: 1, height: 0.7358, reach: 22 / 24 } },
  gemini: { src: gemini, optical: { left: 0.0417, top: 0.0417, width: 0.9167, height: 0.9167, reach: 23 / 24 } },
  glm: { src: glm, optical: { left: 0, top: 0.0833, width: 1, height: 0.8333, reach: 21 / 24 } },
  grok: { src: grok, optical: { left: 0.0004, top: 0.0221, width: 0.9988, height: 0.9583, reach: 1, hang: 0.14 } },
  kimi: { src: kimi, optical: { left: 0.125, top: 0, width: 0.8654, height: 0.8333, reach: 23 / 24 } },
  llama: { src: llama, optical: { left: 0, top: 0.1667, width: 1, height: 0.6667, reach: 1 } },
  minimax: { src: minimax, optical: { left: 0, top: 0.0833, width: 1, height: 0.8333, reach: 1 } },
  mistral: { src: mistral, optical: { left: 0, top: 0.1417, width: 1, height: 0.7142, reach: 21 / 24 } },
  openai: { src: openai, optical: { left: 0, top: 0, width: 1, height: 0.9912, reach: 22 / 24 } },
  qwen: { src: qwen, optical: { left: 0, top: 0, width: 0.9829, height: 1, reach: 19 / 24 } },
};

export interface ModelMarkProps {
  family: ModelFamily;
  size?: number;
}

/**
 * 模型家族的品牌标。矢量形状仍是字节未改的单色官方标（来源与许可见 public/licenses/MODEL-MARKS.md），
 * 用遮罩铺色：有官方品牌色的家族由 marks/brand.css 铺原生色或官方渐变；官方只有黑白标的家族
 * （OpenAI、xAI、Kimi、Composer）保持 scene.css 的中性墨色，不拿颜色冒充品牌。
 * 认不出的家族本来就不会画标（lib/modelFamily.ts），占位的中性 model-glyph 也不在此受品牌色影响。
 */
export function ModelMark({ family, size = 12 }: ModelMarkProps): ReactNode {
  const style = { width: size, height: size, "--mark": `url("${MODEL_MARKS[family].src}")` } as CSSProperties;
  return <span className="model-mark" data-family={family} style={style} aria-hidden="true" />;
}

/**
 * 没有家族标可画时占同一格的中性线图，路径与 Icon 的 sparkle / flask 是同一套：认不出的模型画闪光（与设置窗口“执行端”分区里模型列表的占位一致），
 * 模拟执行的模型是假的，画烧瓶——两者都不借别家的标，也不带任何品牌色。它们在格子里同样按可见包围盒摆放；
 * 线图的线帽是方头、线角是斜接（Icon 里的 MITER_LIMIT），可见包围盒按路径与线宽算（尖角超过斜接上限的会被削平，已计入），
 * 测试 ModelMark.optical.test.tsx 用同一套算法核对这张表；没有在 Chrome 里重新量过。
 * 线图比实心标轻得多，所以按“轻”画：闪光长边 18、烧瓶长边 20（墨量按路径长度 × 线宽粗算，约 87 与 107 px²，未计线帽与转角；比最轻的家族标 grok 的 130 还轻），浅灰，没有框与底——
 * 满格或加深就成了一枚按钮。两者在屏幕上的描边同为约 1.5px，stroke 是折回 24 画布的线宽（放大倍数不同，所以数字不同）。
 */
export const MODEL_PLACEHOLDERS = {
  unknown: { icon: "sparkle", stroke: 1.55, optical: { left: 0.1771, top: 0.1355, width: 0.7106, height: 0.7731, reach: 18 / 24 } },
  simulated: { icon: "flask", stroke: 1.39, optical: { left: 0.1929, top: 0.1169, width: 0.6142, height: 0.7704, reach: 20 / 24 } },
} as const satisfies Record<string, { icon: "sparkle" | "flask"; stroke: number; optical: Optical }>;

/** 图形的边长，以及把它的可见左缘平移到格子左缘（带 hang 的再向左挪 hang，让主体而不是发丝贴边）、可见中心落在格子竖向中心所需的平移（图片框先由 flex 竖向居中）。 */
function placement(optical: Optical, size: number): { box: number; translate: string } {
  const box = (size * optical.reach) / Math.max(optical.width, optical.height);
  return { box, translate: `${-(optical.left + (optical.hang ?? 0)) * box}px ${(0.5 - optical.top - optical.height / 2) * box}px` };
}

export interface ModelSlotProps {
  /** 认得的家族；undefined 是认不出的模型（或没有模型）。 */
  family: ModelFamily | undefined;
  /** 模拟执行端的模型是假的：画烧瓶，即便名字像某个家族也不画那个家族的标。 */
  simulated?: boolean;
  /** 格子的边长，默认 24（画布会话卡正文左边那一格）。 */
  size?: number;
  /**
   * 悬停提示（模型与推理强度，或“模拟执行”的说明），写在格子上：会话卡头部的模型名在窄卡上会因放不下而整块收起，
   * 头像是这张卡上始终在场的那个悬停目标，名字被收起时也能读到。没有就不写属性（设置窗口、列表里的头像不带提示）。
   */
  tip?: string;
}

/**
 * 画布会话卡正文左边的“模型头像”格：没有框、没有底色，只有图形。size 是格子，不画出来——
 * 图形按各自的光学大小放进格子，**可见**的左缘贴着格子的左缘，竖向居中：列轴对齐的是图形，不是图片框（几何见 MODEL_MARKS 上的注释）。
 * 家族标仍是 `.model-mark` 的遮罩，品牌色层（marks/brand.css）照常铺色；12px 的 ModelMark 不受影响。
 */
export function ModelSlot({ family, simulated = false, size = 24, tip }: ModelSlotProps): ReactNode {
  const slot = { width: size, height: size };
  if (family && !simulated) {
    const { src, optical } = MODEL_MARKS[family];
    const { box, translate } = placement(optical, size);
    const style = { width: box, height: box, translate, "--mark": `url("${src}")` } as CSSProperties;
    return (
      <span className="model-slot" data-tip={tip} style={slot} aria-hidden="true">
        <span className="model-mark" data-family={family} style={style} />
      </span>
    );
  }
  const kind = simulated ? "simulated" : "unknown";
  const { icon, stroke, optical } = MODEL_PLACEHOLDERS[kind];
  const { box, translate } = placement(optical, size);
  return (
    <span className="model-slot" data-placeholder={kind} data-tip={tip} style={slot} aria-hidden="true">
      <Icon name={icon} size={box} strokeWidth={stroke} className="model-glyph" style={{ translate }} />
    </span>
  );
}
