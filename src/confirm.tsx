import { useEffect, useState } from 'react';
import { Switch } from './ui-controls';

/**
 * In-app confirmation dialogs. Native window.confirm() is avoided on purpose: in Electron on
 * Windows it can leave text boxes unable to take focus until the window is switched away
 * and back, which looks like the whole app has frozen.
 */
export interface ConfirmOptions { title: string; message?: string; confirmLabel?: string; cancelLabel?: string; thirdLabel?: string; danger?: boolean; option?: { label: string; checked: boolean } }
interface Pending extends ConfirmOptions { resolve: (value: boolean | null, option?: boolean) => void }

let show: ((request: Pending) => void) | null = null;
const queue: Pending[] = [];

export function askConfirm(options: ConfirmOptions): Promise<boolean | null> {
  return new Promise((resolve) => {
    const request = { ...options, resolve };
    if (show) show(request); else queue.push(request);
  });
}

/** 確認對話框附帶一個開關選項；回傳是否確認與開關最後的狀態。 */
export function askConfirmWithOption(options: ConfirmOptions & { option: { label: string; checked: boolean } }): Promise<{ confirmed: boolean; option: boolean }> {
  return new Promise((resolve) => {
    const request: Pending = { ...options, resolve: (value, option) => resolve({ confirmed: value === true, option: option ?? options.option.checked }) };
    if (show) show(request); else queue.push(request);
  });
}

export function ConfirmHost() {
  const [request, setRequest] = useState<Pending | null>(null);
  const [optionChecked, setOptionChecked] = useState(false);
  useEffect(() => { setOptionChecked(request?.option?.checked ?? false); }, [request]);
  useEffect(() => {
    show = (next) => setRequest(next);
    const waiting = queue.shift();
    if (waiting) setRequest(waiting);
    return () => { show = null; };
  }, []);
  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); finish(request.thirdLabel ? null : false); }
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  if (!request) return null;
  const finish = (value: boolean | null) => {
    request.resolve(value, optionChecked);
    const next = queue.shift() ?? null;
    setRequest(next);
  };
  return <div className="dialog-backdrop confirm-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) finish(request.thirdLabel ? null : false); }}>
    <section className="app-dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
      <h2 id="confirm-title">{request.title}</h2>
      {request.message && <p className="dialog-copy">{request.message}</p>}
      {request.option && <div className="confirm-option"><Switch checked={optionChecked} onChange={setOptionChecked} label={request.option.label} /></div>}
      <footer>
        <button className={request.danger ? 'button-primary button-danger' : 'button-primary'} autoFocus onClick={() => finish(true)}>{request.confirmLabel ?? '確定'}</button>
        <button className="text-button" onClick={() => finish(false)}>{request.cancelLabel ?? '取消'}</button>
        {request.thirdLabel && <button className="text-button" onClick={() => finish(null)}>{request.thirdLabel}</button>}
      </footer>
    </section>
  </div>;
}
