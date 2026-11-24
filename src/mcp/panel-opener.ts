import { openInSystemBrowser } from "../server/open-url";

export interface PanelOpenerOptions {
  /** 桥进程的环境变量：`ENSEMBLE_AUTO_OPEN` 决定委派之后要不要自动打开面板。 */
  env: NodeJS.ProcessEnv;
  /** 在系统浏览器里打开地址（测试注入）；没有就用系统默认浏览器。 */
  openExternal?: ((url: string) => Promise<void> | void) | undefined;
}

/** 在系统浏览器里打开面板：委派之后的自动打开（整个桥进程只一次），与 `open_panel` 工具里显式要求的那一种。 */
export class PanelOpener {
  private autoOpened = false;

  constructor(private readonly options: PanelOpenerOptions) {}

  /**
   * 新建了会话之后，环境变量 `ENSEMBLE_AUTO_OPEN` 要求时在系统浏览器里打开面板。整个桥进程只打开一次，这个状态由桥实例持有（每个桥一个 `PanelOpener`）；
   * delegate 工具每次新建会话都来问一遍，命中重复委派（没有新建任何东西）时不来问。
   */
  async openPanelOnce(url: string): Promise<void> {
    if (this.autoOpened || !/^(1|true|system)$/i.test(this.options.env["ENSEMBLE_AUTO_OPEN"] ?? "")) return;
    this.autoOpened = true;
    await this.openInSystemBrowser(url).catch(() => undefined);
  }

  async openInSystemBrowser(url: string): Promise<void> {
    if (this.options.openExternal) {
      await this.options.openExternal(url);
      return;
    }
    openInSystemBrowser(url);
  }
}
