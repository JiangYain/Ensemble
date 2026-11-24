import { hostname } from "node:os";
import { CURSOR_SDK_VERSION } from "@shared/constants";
import { errorMessage } from "@shared/format";
import { asRecord, num, str } from "../server/executors/common";
import { defaultSdkLoader, type CursorSdkLoader, type LoadedCursorSdk } from "../server/executors/cursor-sdk-loader";

/**
 * `cursor-login`：由用户主动发起的 Cursor 登录。
 *
 * 登录会在用户的 Cursor 账号里创建一把有期限的 API Key，所以这里从不自动执行：
 * 必须有明确确认（交互式回答，或 --yes），并且先把会发生什么讲清楚。
 * 密钥只由 SDK 保存到它自己的凭据存储，这里不读取、不显示、不记录。
 */

/** 登录得到的 API Key 的有效期。显式传给 SDK，下面的说明才与实际一致（SDK 默认值也是 90 天）。 */
const KEY_TTL_DAYS = 90;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface CursorLoginIO {
  out(text?: string): void;
  err(text?: string): void;
  /** 交互式确认；非交互环境下不会被调用。 */
  confirm(question: string): Promise<boolean>;
  interactive: boolean;
}

export interface CursorLoginOptions {
  flags: ReadonlySet<string>;
  env: NodeJS.ProcessEnv;
  /** Ensemble 管理的依赖目录（<home>/runtime）。 */
  runtimeDir: string;
  /** 测试用：直接提供 SDK。 */
  loadSdk?: CursorSdkLoader;
  io: CursorLoginIO;
  timeoutMs?: number;
}

function dateOf(ms: number | undefined): string | undefined {
  return ms !== undefined && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
}

export async function runCursorLogin(options: CursorLoginOptions): Promise<number> {
  const { io, flags } = options;

  let loaded: LoadedCursorSdk;
  try {
    loaded = await (options.loadSdk ?? defaultSdkLoader({ env: options.env, runtimeDir: options.runtimeDir }))();
  } catch (error) {
    io.err(`没有找到 Cursor SDK（@cursor/sdk）：${errorMessage(error)}`);
    io.err("它带有原生组件、许可证不允许随插件分发，需要你确认后安装：");
    io.err(`  npm install --prefix "${options.runtimeDir}" --no-audit --no-fund @cursor/sdk@${CURSOR_SDK_VERSION}`);
    return 1;
  }
  const auth = loaded.sdk.Cursor.auth;

  let status: Record<string, unknown> | undefined;
  try {
    status = asRecord(await auth.status());
  } catch (error) {
    io.err(`读取登录状态失败：${errorMessage(error)}`);
    return 1;
  }
  const loggedIn = str(status?.["status"]) === "logged-in";
  const email = str(status?.["email"]);
  const expires = dateOf(num(status?.["apiKeyExpiresAtMs"]));
  const hasEnvKey = (options.env["CURSOR_API_KEY"]?.trim() ?? "") !== "";

  if (flags.has("status")) {
    io.out(loggedIn ? `已登录 Cursor${email ? `：${email}` : ""}${expires ? ` · 密钥有效期至 ${expires}` : ""}` : "没有保存的 Cursor 登录。");
    if (hasEnvKey) io.out("检测到环境变量 CURSOR_API_KEY：Ensemble 会优先使用它。");
    return 0;
  }

  if (flags.has("logout")) {
    if (!loggedIn) {
      io.out("本机没有保存的 Cursor 登录。");
      return 0;
    }
    if (typeof auth.logout !== "function") {
      io.err("这个版本的 Cursor SDK 不支持退出登录。");
      return 1;
    }
    io.out("这只会让本机忘记保存的登录；已经创建的 API Key 在到期前仍然有效，可以在 Cursor Dashboard 的 API Keys 页面撤销。");
    if (!(await confirmed(options, "退出本机的 Cursor 登录？"))) return io.interactive ? 1 : 2;
    await auth.logout();
    io.out("已退出本机的 Cursor 登录。");
    return 0;
  }

  if (loggedIn && !flags.has("force")) {
    io.out(`已经登录 Cursor${email ? `：${email}` : ""}${expires ? ` · 密钥有效期至 ${expires}` : ""}。如需重新登录，请加上 --force。`);
    return 0;
  }
  if (typeof auth.login !== "function") {
    io.err("这个版本的 Cursor SDK 不支持交互式登录。请改用环境变量 CURSOR_API_KEY（Cursor Dashboard → Integrations）。");
    return 1;
  }

  const keyName = `Ensemble · ${hostname()}`;
  io.out("登录会做三件事：");
  io.out("  1. 在浏览器里打开 Cursor 的登录页，由你登录并授权；");
  io.out(`  2. 在你的 Cursor 账号里创建一把名为“${keyName}”的 API Key，${KEY_TTL_DAYS} 天后到期；`);
  io.out("  3. 由 SDK 把它保存到本机的凭据存储（通常是 ~/.cursor/sdk/auth.json），之后 Ensemble 用它连接 Cursor。");
  io.out("密钥不会显示在这里，也不会写进 Ensemble 的日志或会话记录。到期前随时可以在 Cursor Dashboard 的 API Keys 页面撤销。");
  if (!(await confirmed(options, "继续登录？"))) return io.interactive ? 1 : 2;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? LOGIN_TIMEOUT_MS);
  try {
    const result = asRecord(
      await auth.login({
        apiKeyName: keyName,
        apiKeyTtlMs: KEY_TTL_DAYS * 24 * 60 * 60 * 1000,
        openBrowser: true,
        onLoginUrl: (url: string) => io.err(`如果浏览器没有自动打开，请手动访问：\n  ${url}`),
        signal: controller.signal,
      }),
    );
    const until = dateOf(num(result?.["apiKeyExpiresAtMs"]));
    const who = str(result?.["email"]);
    io.out(`登录成功${who ? `：${who}` : ""}${until ? ` · 密钥有效期至 ${until}` : ""}。`);
    io.out("回到 Ensemble 面板点击“重新探测”，或运行 doctor 确认 Cursor 已就绪。");
    return 0;
  } catch (error) {
    io.err(`登录没有完成：${errorMessage(error)}`);
    return 1;
  } finally {
    clearTimeout(timer);
  }
}

/** --yes 直接确认；交互环境下询问；非交互且没有 --yes 时拒绝，并说明怎样确认。 */
async function confirmed(options: CursorLoginOptions, question: string): Promise<boolean> {
  const { io, flags } = options;
  if (flags.has("yes")) return true;
  if (!io.interactive) {
    io.err("这需要你的明确确认。确认后请加上 --yes 重新运行。");
    return false;
  }
  const answer = await io.confirm(question);
  if (!answer) io.out("已取消，没有做任何改动。");
  return answer;
}
