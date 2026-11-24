/**
 * 把一段文本交给浏览器保存成文件：Blob → 临时链接 → 点一下看不见的 `<a download>` → 稍后撤销链接。
 * 令牌只在请求头里（见 api.report），这里的链接是 `blob:`，不带令牌，也不是服务的地址；
 * 不弹任何对话框：保存到哪里、要不要询问，由浏览器自己的下载设置决定。
 */
export function saveTextFile(filename: string, text: string, type = "text/markdown;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // 点击之后下载由浏览器接手；撤销晚一点再做，个别浏览器在同一轮里撤销会把刚开始的下载取消掉。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
