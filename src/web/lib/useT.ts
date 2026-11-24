import { useMemo } from "react";
import { store } from "./app";
import { bindT, type Lang, type TFunction } from "./i18n";
import { useStore } from "./store";

export function useLang(): Lang {
  return useStore(store, (s) => s.lang);
}

/** 绑定当前语言的翻译函数；语言切换时引用变化，使用它的组件会重新渲染。 */
export function useT(): TFunction {
  const lang = useLang();
  return useMemo(() => bindT(lang), [lang]);
}
