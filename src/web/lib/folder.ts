import { pathName } from "./text";

/**
 * 画布上的 Folder 节点：来源（Main Agent）自己带着的工作目录（`OriginSummary.workspace`），抽出来成为一个独立的节点。
 * 这里只处理字符串：不读文件系统、不问服务端，所以也不说这个目录“存在”还是“不存在”。
 */

const DRIVE = /^[A-Za-z]:(?=[\\/]|$)/;
const EXTENDED = /^[\\/]{2}[?.][\\/](?:(UNC)[\\/])?/i;

/**
 * 一个目录的身份：路径规范化后的写法。同一个真实目录的不同写法得到同一个 key，不同目录不会被抹平。
 *
 * 规范化只抹平“同一个目录的不同写法”：
 *  - Windows 路径（盘符或 UNC）：正反斜杠不分、盘符与目录名不分大小写（NTFS 默认如此）、多余与结尾的分隔符、`.` / `..`、
 *    扩展长度前缀（`\\?\C:\repo`、`\\?\UNC\host\share`）；
 *  - 其余（POSIX）路径：区分大小写，反斜杠是文件名的一部分，只处理多余与结尾的分隔符和 `.` / `..`。
 * 前端读不了文件系统，所以 8.3 短名、junction、subst 盘这类要靠系统才能解开的别名不在其内：它们的写法若不同，就按不同的目录对待。
 * 空串（或只有空白）没有身份，返回空串。
 */
export function directoryKey(path: string): string {
  let text = path.trim();
  if (!text) return "";
  const extended = EXTENDED.exec(text);
  if (extended) {
    const rest = text.slice(extended[0].length);
    if (extended[1]) text = `\\\\${rest}`;
    else if (DRIVE.test(rest)) text = rest;
  }

  const windows = DRIVE.test(text) || /^[\\/]{2}[^\\/]/.test(text);
  const slashed = windows ? text.replaceAll("\\", "/") : text;
  let head = "";
  let rest = slashed;
  if (DRIVE.test(slashed)) {
    head = slashed.slice(0, 2);
    rest = slashed.slice(2);
  } else if (windows) {
    // //host/share/…：主机与共享名一起算作“根”，`..` 不能越过它。
    const unc = /^\/\/([^/]+)(?:\/([^/]+))?/.exec(slashed);
    head = unc ? unc[0] : "";
    rest = slashed.slice(head.length);
  }

  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const absolute = head !== "" || rest.startsWith("/");
  const key = `${head}${absolute ? "/" : ""}${parts.join("/")}`;
  return windows ? key.toLowerCase() : key;
}

/** 画布上的一张 Folder 卡：一个真实的目录，和所有把它当工作目录的来源（Main Agent）。 */
export interface FolderGroup {
  /** 目录的稳定标识（见 directoryKey）。卡片的节点 id 由它得来，不随来源的先后、增减而变。 */
  key: string;
  /**
   * 卡片上写的目录。各来源报告的写法可能不同（大小写、斜杠方向、结尾的分隔符），取结尾没有分隔符的、再按字典序最小的一种，
   * 与来源出现的先后无关——同一个目录每次都写成同一个样子。
   */
  path: string;
  /** 用这个目录的来源 key（每个来源各一条连线）；按字典序。 */
  origins: string[];
}

const trailing = (path: string): number => path.length - path.replace(/[\\/]+$/, "").length;

/** 同一个目录的几种写法里，卡片上用哪一种。 */
function representative(a: string, b: string): string {
  const gap = trailing(a) - trailing(b);
  if (gap !== 0) return gap < 0 ? a : b;
  return a <= b ? a : b;
}

/**
 * 把来源按真实目录归并：写法不同、指的是同一个目录的是一组，一张卡；目录不同就是不同的组。
 * 没有工作目录的来源不属于任何一组。结果按目录 key 排序，与输入的迭代顺序无关。
 */
export function groupFolders(workspaceOf: ReadonlyMap<string, string>): FolderGroup[] {
  const groups = new Map<string, { path: string; origins: string[] }>();
  for (const [origin, workspace] of workspaceOf) {
    const key = directoryKey(workspace);
    if (!key) continue;
    const spelled = workspace.trim();
    const group = groups.get(key);
    if (group) {
      group.path = representative(group.path, spelled);
      group.origins.push(origin);
    } else {
      groups.set(key, { path: spelled, origins: [origin] });
    }
  }
  return [...groups]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, { path, origins }]) => ({ key, path, origins: origins.sort() }));
}

/** 卡片主行写的名字：目录的最后一段。根目录（`/`）没有最后一段，就写它自己。 */
export function folderName(path: string): string {
  return pathName(path) || path;
}

/**
 * 卡片次行写的上级路径，保留来源报告时用的分隔符；没有上级（盘符根目录、`/`）就是空串。
 * `C:\a\b` → `C:\a`，`C:\a` → `C:\`，`/a` → `/`。
 */
export function parentPath(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return "";
  const head = trimmed.slice(0, cut).replace(/[\\/]+$/, "");
  if (head === "") return trimmed.slice(0, 1);
  if (/^[A-Za-z]:$/.test(head)) return `${head}${trimmed.charAt(cut)}`;
  return head;
}
