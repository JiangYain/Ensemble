/**
 * 测试专用的临时目录根。
 *
 * 不少测试要在系统临时目录里建工作目录、假执行端的日志和状态目录，并不逐个清理。
 * 这里在测试开始前把 TEMP / TMP / TMPDIR 指向一个独立目录，结束后整体删除，
 * 这样 `vitest run` 不会往用户的临时目录里留下成百上千个文件夹。
 * 测试启动的子进程继承同一组环境变量，它们建的目录也落在这个根目录里。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VARIABLES = ["TEMP", "TMP", "TMPDIR"] as const;
const MARKER = "ENSEMBLE_TEST_SCRATCH_ROOT";

export default function setup(): () => void {
  // 多个 project 会各自执行一次全局准备，只建一个根目录。
  if (process.env[MARKER]) return () => {};

  const saved = VARIABLES.map((name) => [name, process.env[name]] as const);
  const root = mkdtempSync(join(tmpdir(), "ensemble-vitest-"));
  for (const name of VARIABLES) process.env[name] = root;
  process.env[MARKER] = root;

  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    delete process.env[MARKER];
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[ensemble] 没能删除测试临时目录 ${root}：${reason}\n`);
    }
  };
}
