import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Origin } from "@shared/types";

/**
 * 老版本的桥（2026-11-17 之前）记录来源工作目录的办法是 `宿主 roots ?? 桥进程的启动目录`，并且不带 workspaceSource。
 * 在 Cursor 里这两样都帮不上：roots 读不出来（Cursor 回的 `uri` 是普通路径而不是 `file://`，被 MCP SDK 的校验挡掉），
 * 桥又是 Cursor 从用户主目录拉起来的，于是每个来源的工作目录都成了用户主目录——来源卡上写着 `C:\Users\<用户名>`。
 *
 * 已安装的桥比服务老（什么时候重装插件由用户决定），服务先重启就能让之后新建的会话显示对，不必等重装：
 * 老桥发来的请求里 `cwd = 显式传入的 cwd ?? roots ?? 桥进程目录`，而 `origin.workspace = roots ?? 桥进程目录`，
 * 所以 `cwd` 与 `origin.workspace` 不同，就说明 `cwd` 是显式传入的（否则两者相等）。
 * 新桥写目录时一定带 workspaceSource，所以“有目录、没有来历、而且恰好是用户主目录”只可能是老桥记下的它自己的启动目录。
 * 这时把来源的工作目录改记成显式传入的 `cwd`，并如实标成 delegate-cwd。
 *
 * 取舍：只认用户主目录这一种（Cursor 的实际情况）。老桥在别的宿主里也可能把插件安装目录记成来源目录，那一种没有处理——
 * 判断它要去看磁盘上有没有插件清单，属于桥那一侧的知识，服务不该越界。
 * 只改正在创建的这一个会话带来的来源；已经存下来的会话原样不动。
 * 老桥没传 `cwd`（或传的就是主目录）时没法区分“真的在主目录里”与“桥的启动目录”，保持原样。
 */
export function reconcileLegacyWorkspace(origin: Origin, cwd: string, home: string = homedir()): Origin {
  if (!origin.workspace || origin.workspaceSource) return origin;
  if (!isAbsolute(origin.workspace) || !isAbsolute(cwd)) return origin;
  if (!sameDirectory(origin.workspace, home) || sameDirectory(origin.workspace, cwd)) return origin;
  return { ...origin, workspace: cwd, workspaceSource: "delegate-cwd" };
}

/** Windows 与 macOS 上不区分大小写；只做字符串处理，不访问磁盘。 */
function sameDirectory(a: string, b: string): boolean {
  const key = (dir: string): string => {
    const absolute = resolve(dir);
    return process.platform === "win32" || process.platform === "darwin" ? absolute.toLowerCase() : absolute;
  };
  return key(a) === key(b);
}
