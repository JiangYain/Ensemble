import { useRef, useState, type ReactNode } from "react";
import { closeConfirm, dismissToast, store, type ConfirmRequest, type Toast } from "../lib/app";
import { useStore } from "../lib/store";
import { useT } from "../lib/useT";
import { Icon } from "./Icons";
import { Modal } from "./Modal";
import { Spinner } from "./ui";

export function ConfirmDialog(): ReactNode {
  const t = useT();
  const request = useStore(store, (s) => s.confirm);
  const last = useRef<ConfirmRequest | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  if (request) last.current = request;
  const shown = request ?? last.current;

  const run = async (): Promise<void> => {
    if (!request || busy) return;
    setBusy(true);
    try {
      await request.onConfirm();
    } finally {
      setBusy(false);
      closeConfirm();
    }
  };

  return (
    <Modal open={request !== undefined} onClose={() => !busy && closeConfirm()} label={shown?.title ?? t("confirm.label")} width={400} initialFocus="[data-autofocus]">
      {shown ? (
        <div className="confirm">
          <div className="confirm-icon" data-tone={shown.tone ?? "default"}>
            <Icon name={shown.tone === "danger" ? "trash" : "info"} size={20} />
          </div>
          <h2 className="confirm-title">{shown.title}</h2>
          {shown.body ? <p className="confirm-body">{shown.body}</p> : null}
          <div className="confirm-actions">
            <button type="button" className="btn btn--ghost" data-autofocus disabled={busy} onClick={closeConfirm}>
              {t("common.cancel")}
            </button>
            <button type="button" className={`btn ${shown.tone === "danger" ? "btn--danger" : "btn--primary"}`} disabled={busy} aria-busy={busy || undefined} onClick={() => void run()}>
              {busy ? <Spinner size={13} /> : null}
              {shown.confirmLabel}
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

const TOAST_ICON = { info: "info", success: "check", warn: "alert", error: "alert" } as const;

/** 提示里的小动作（例如归档之后的“撤销”）：一个普通按钮，Tab 可达；点了先收起这条提示再执行，不会被连点两次。 */
function ToastAction({ id, action }: { id: number; action: NonNullable<Toast["action"]> }): ReactNode {
  return (
    <button
      type="button"
      className="link-btn toast-action"
      onClick={() => {
        dismissToast(id);
        action.run();
      }}
    >
      {action.label}
    </button>
  );
}

export function Toasts(): ReactNode {
  const t = useT();
  const toasts = useStore(store, (s) => s.toasts);
  return (
    <div className="toasts" role="region" aria-label={t("toast.region")}>
      {toasts.map((toast) => (
        <div key={toast.id} className="toast" data-tone={toast.tone} role={toast.tone === "error" ? "alert" : "status"}>
          <Icon name={TOAST_ICON[toast.tone]} size={15} strokeWidth={toast.tone === "success" ? 2.2 : 1.7} />
          <span className="toast-text">{toast.text}</span>
          {toast.action ? <ToastAction id={toast.id} action={toast.action} /> : null}
          <button type="button" className="icon-btn icon-btn--bare" aria-label={t("common.dismiss")} onClick={() => dismissToast(toast.id)}>
            <Icon name="close" size={13} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  );
}
