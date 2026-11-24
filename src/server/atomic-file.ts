import { rename, rm, writeFile } from "node:fs/promises";

/**
 * 原子地写一个小文件（summary.json、archive.json、settings.json）：先写同目录下独一无二的临时文件，再改名覆盖目标。
 * 读的人任何时刻看到的要么是完整的旧内容、要么是完整的新内容，进程中途被杀也不会留下半截文件。
 *
 * - 不创建目录：目录不存在（会话刚被删除）时直接以 ENOENT 失败，而不是为一个已经删除的会话重新建出一个只有快照的目录。
 * - Windows 上改名在目标文件被杀毒软件、索引服务或别的进程短暂占用时会偶发 EPERM / EBUSY / EACCES，
 *   所以重试几次（settings.json 的写入也走这里）；其他错误立即抛出。
 */
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);
const ATTEMPTS = 6;
const BACKOFF_MS = 15;

let sequence = 0;

export async function writeFileAtomic(file: string, contents: string): Promise<void> {
  // pid 与递增序号让并发的写各用各的临时文件，互不踩踏。
  const temp = `${file}.${process.pid}.${++sequence}.tmp`;
  try {
    await writeFile(temp, contents, "utf8");
    await renameWithRetry(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= ATTEMPTS || code === undefined || !RETRYABLE.has(code)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, BACKOFF_MS * attempt));
    }
  }
}

/** 删一个小文件；不存在不算错，Windows 上被短暂占用时重试几次。 */
export async function removeFileQuiet(file: string): Promise<void> {
  await rm(file, { force: true, maxRetries: 3, retryDelay: 25 });
}
