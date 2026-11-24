import { ENV } from "@shared/constants";

/**
 * 启动时怎样载入历史会话：
 * - lazy（默认）：只读各会话的摘要快照，已结束的会话作为“冷会话”登记、完整事件日志按需读取，过了保温期的已结束会话也会被放出内存；
 * - eager：老办法——启动时把全部会话的日志重放进内存、从不冻结。出了问题时用它排除冷热分离的影响（逃生口）。
 */
export type HistoryMode = "lazy" | "eager";

export interface HistoryModeChoice {
  mode: HistoryMode;
  /** 环境变量里写了、但认不出的值（原样返回，供启动日志说明）；没写或写对了就没有。 */
  ignored?: string;
}

/**
 * 从环境变量读取（只在启动时读一次）。不区分大小写；认不出的写法按默认（lazy）处理并报告出来——
 * 环境变量写错不该让服务起不来，也不该悄悄变成一个没人想要的模式。
 */
export function historyModeFrom(env: NodeJS.ProcessEnv): HistoryModeChoice {
  const raw = env[ENV.historyMode]?.trim();
  if (!raw) return { mode: "lazy" };
  const value = raw.toLowerCase();
  if (value === "eager") return { mode: "eager" };
  if (value === "lazy") return { mode: "lazy" };
  return { mode: "lazy", ignored: raw };
}
