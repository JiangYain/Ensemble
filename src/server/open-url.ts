import { spawn } from "node:child_process";

/**
 * 在系统默认浏览器里打开地址。Windows 使用 FileProtocolHandler 而不是 `cmd /c start`，
 * 这样地址里的 & 等字符不会被命令行解析。进程与调用者脱离，失败只会静默（调用方应同时给出地址）。
 */
export function openInSystemBrowser(url: string): void {
  if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) URLs can be opened.");
  const [command, args] =
    process.platform === "win32"
      ? (["rundll32", ["url.dll,FileProtocolHandler", url]] as const)
      : process.platform === "darwin"
        ? (["open", [url]] as const)
        : (["xdg-open", [url]] as const);
  const child = spawn(command, [...args], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => undefined);
  child.unref();
}
