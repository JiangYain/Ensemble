/**
 * 仅供测试使用：manager.test.ts、manager.queueing.test.ts、manager.lifecycle.test.ts 共用的委派辅助：
 * 向 pi 执行端委派，任务、工作目录与来源都已填好（见 testing.ts 的 delegatorFor）。
 */

import { delegatorFor } from "./testing";

export const delegate = delegatorFor("pi", "Refactor the parser module");
