import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './ui-controls.css';

/**
 * SceneForge 共用控制元件。整個 App 不使用原生 <select>／checkbox／number 外觀：
 * 所有下拉、開關都走這裡，保證外觀、動畫、鍵盤與關閉規則一致。
 */

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  /** 右側灰字，例如「12 場」。 */
  hint?: string;
  /** 語意色：只用於伏筆與設定的狀態（未回收／已回收／擱置），觸發鈕與該選項整列上色；其他選單一律不給 tone。 */
  tone?: string;
  disabled?: boolean;
  /** 分組標題；同一 group 的選項會排在一起並顯示標題。 */
  group?: string;
  /** 讓同名幕的不同實際分組仍可分別收合。 */
  groupKey?: string;
}

interface SelectProps<V extends string> {
  value: V;
  options: SelectOption<V>[];
  onChange: (value: V) => void;
  ariaLabel: string;
  placeholder?: string;
  /** 觸發鈕用目前選項的 tone 上色。 */
  toned?: boolean;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  /** 選單寬度至少等於觸發鈕；可再指定最小寬。 */
  menuMinWidth?: number;
  /** 點擊觸發鈕不要冒泡（放在可展開卡片標題時用）。 */
  stopPropagation?: boolean;
  /** 將分組標題變成可收合的幕／集標題列。 */
  collapsibleGroups?: boolean;
  /** 在高亮選項停留 600ms 後顯示非互動預覽。 */
  preview?: (option: SelectOption<V>) => ReactNode;
}

let openCloser: (() => void) | null = null;
/** 讓所有浮層互斥：開新的時關掉上一個。 */
export function claimPopover(close: () => void) {
  if (openCloser && openCloser !== close) openCloser();
  openCloser = close;
  return () => { if (openCloser === close) openCloser = null; };
}

const truncateWatchers = new Set<HTMLElement>();
const pendingTruncateMeasures = new Set<HTMLElement>();
let truncateObserver: ResizeObserver | null = null;
let truncateFrame = 0;
let truncateResizeFallback = false;
let truncateFontsListener = false;
function scheduleTruncationMeasure(element: HTMLElement) {
  if (!truncateWatchers.has(element)) return;
  pendingTruncateMeasures.add(element);
  if (truncateFrame) return;
  truncateFrame = requestAnimationFrame(() => {
    truncateFrame = 0;
    const batch = [...pendingTruncateMeasures];
    pendingTruncateMeasures.clear();
    for (const item of batch) {
      if (!truncateWatchers.has(item)) continue;
      const overflowing = item.scrollWidth > item.clientWidth + 1;
      const title = overflowing ? item.textContent ?? '' : '';
      if (title) {
        if (item.getAttribute('title') !== title) item.setAttribute('title', title);
      } else if (item.hasAttribute('title')) item.removeAttribute('title');
    }
  });
}
function observeTruncation(element: HTMLElement) {
  truncateWatchers.add(element);
  if (typeof ResizeObserver === 'undefined') {
    if (!truncateResizeFallback) {
      truncateResizeFallback = true;
      window.addEventListener('resize', scheduleAllTruncationMeasures);
    }
  } else {
    truncateObserver ??= new ResizeObserver((entries) => {
      for (const entry of entries) scheduleTruncationMeasure(entry.target as HTMLElement);
    });
    truncateObserver.observe(element);
  }
  scheduleTruncationMeasure(element);
  return () => {
    truncateObserver?.unobserve(element);
    truncateWatchers.delete(element);
    pendingTruncateMeasures.delete(element);
    if (!truncateWatchers.size) {
      truncateObserver?.disconnect();
      truncateObserver = null;
      if (truncateResizeFallback) {
        window.removeEventListener('resize', scheduleAllTruncationMeasures);
        truncateResizeFallback = false;
      }
      if (truncateFrame) cancelAnimationFrame(truncateFrame);
      truncateFrame = 0;
      pendingTruncateMeasures.clear();
    }
  };
}
function scheduleAllTruncationMeasures() {
  for (const element of truncateWatchers) scheduleTruncationMeasure(element);
}

/** Single-line label that exposes its full name only when CSS actually clips it. */
export function TruncateText({ text, className = '' }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const stop = observeTruncation(element);
    const measureAfterFonts = () => scheduleTruncationMeasure(element);
    void document.fonts?.ready.then(measureAfterFonts).catch(() => undefined);
    return stop;
  }, [text]);
  return <span ref={ref} className={`sf-truncate${className ? ` ${className}` : ''}`}>{text}</span>;
}

export function Select<V extends string>({ value, options, onChange, ariaLabel, placeholder = '請選擇', toned = false, className = '', style, disabled, menuMinWidth, stopPropagation, collapsibleGroups = false, preview }: SelectProps<V>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [previewPos, setPreviewPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; flip: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const previewTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const previewBox = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = options.find((option) => option.value === value);
  const groupKeyOf = (option: SelectOption<V>) => option.groupKey ?? option.group ?? '';
  const isCollapsed = (option: SelectOption<V>, groups = collapsedGroups) => collapsibleGroups && !!option.group && groups.has(groupKeyOf(option));
  const firstEnabledIndex = () => options.findIndex((option) => !option.disabled && !isCollapsed(option));

  const cancelHide = () => { if (hideTimer.current !== null) window.clearTimeout(hideTimer.current); hideTimer.current = null; };
  const clearPreview = () => {
    cancelHide();
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    previewTimer.current = null;
    setPreviewIndex(null);
    setPreviewPos(null);
  };
  // 游標離開選項或預覽時稍候再關，讓使用者能把游標移進預覽卡捲動閱讀。
  const scheduleHide = () => {
    if (previewTimer.current !== null) { window.clearTimeout(previewTimer.current); previewTimer.current = null; }
    cancelHide();
    hideTimer.current = window.setTimeout(() => { hideTimer.current = null; setPreviewIndex(null); setPreviewPos(null); }, 280);
  };
  const schedulePreview = (index: number) => {
    cancelHide();
    if (!preview || !options[index] || options[index].disabled || isCollapsed(options[index])) { clearPreview(); return; }
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => {
      previewTimer.current = null;
      setPreviewIndex(index);
    }, 600);
  };
  const closeMenu = () => { clearPreview(); setOpen(false); };
  const openMenu = () => {
    if (disabled) return;
    const selectedIndex = options.findIndex((option) => option.value === value);
    const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
    if (selected?.group && isCollapsed(selected)) {
      setCollapsedGroups((groups) => { const next = new Set(groups); next.delete(groupKeyOf(selected)); return next; });
    }
    setActive(selectedIndex >= 0 && !options[selectedIndex].disabled ? selectedIndex : firstEnabledIndex());
    setOpen(true);
  };

  useEffect(() => () => { if (previewTimer.current !== null) window.clearTimeout(previewTimer.current); if (hideTimer.current !== null) window.clearTimeout(hideTimer.current); }, []);

  useEffect(() => {
    if (!open) { clearPreview(); return; }
    const close = () => closeMenu();
    const release = claimPopover(close);
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (trigger.current?.contains(target) || menu.current?.contains(target) || previewBox.current?.contains(target)) return;
      closeMenu();
    };
    // 只有觸發鈕真的被捲動移位才關閉；瀏覽器自動校正 scrollLeft／聚焦捲動不算（否則選單一開就關）。
    const anchor = trigger.current?.getBoundingClientRect();
    const onScroll = (event: Event) => {
      if ((menu.current && menu.current.contains(event.target as Node)) || (previewBox.current && previewBox.current.contains(event.target as Node))) return;
      const now = trigger.current?.getBoundingClientRect();
      if (anchor && now && Math.abs(now.left - anchor.left) < 2 && Math.abs(now.top - anchor.top) < 2) return;
      closeMenu();
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', closeMenu);
    return () => { release(); document.removeEventListener('mousedown', onDown, true); window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', closeMenu); };
  }, [open]);

  useEffect(() => {
    if (open) schedulePreview(active);
  }, [open, active]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, menuMinWidth ?? 0), window.innerWidth - 16);
    const groupCount = new Set(options.filter((option) => option.group).map(groupKeyOf)).size;
    const estimated = Math.min(320, (options.length + groupCount) * 34 + 12);
    const flip = r.bottom + 6 + estimated > window.innerHeight - 8 && r.top > estimated;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    setPos({ left, top: flip ? r.top - 6 : r.bottom + 6, width, flip });
    const selectedIndex = options.findIndex((option) => option.value === value);
    const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
    setActive(selected && !selected.disabled && !isCollapsed(selected) ? selectedIndex : firstEnabledIndex());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!open || !menu.current) return;
    menu.current.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, collapsedGroups]);

  useLayoutEffect(() => {
    if (!open || previewIndex === null || !menu.current) return;
    const option = menu.current.querySelector<HTMLElement>(`[data-index="${previewIndex}"]`);
    if (!option) { setPreviewPos(null); return; }
    const optionRect = option.getBoundingClientRect();
    const menuRect = menu.current.getBoundingClientRect();
    const width = Math.max(0, Math.min(320, window.innerWidth - 16));
    const maxHeight = Math.max(0, Math.min(280, window.innerHeight - 16));
    const besideRight = menuRect.right + 8;
    const desiredLeft = besideRight + width <= window.innerWidth - 8 ? besideRight : menuRect.left - width - 8;
    const left = Math.max(8, Math.min(desiredLeft, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(optionRect.top, window.innerHeight - maxHeight - 8));
    setPreviewPos({ left, top, maxHeight });
  }, [open, previewIndex, pos]);
  // 每次換預覽的場次都從最上面開始看。
  useLayoutEffect(() => { if (previewBox.current) previewBox.current.scrollTop = 0; }, [previewIndex, previewPos]);

  const choose = (option: SelectOption<V> | undefined) => {
    if (!option || option.disabled) return;
    closeMenu();
    trigger.current?.focus();
    if (option.value !== value) onChange(option.value);
  };
  const move = (delta: number) => {
    const enabled = options.map((option, index) => ({ option, index })).filter(({ option }) => !option.disabled && !isCollapsed(option));
    if (!enabled.length) return;
    const currentPosition = enabled.findIndex((entry) => entry.index === active);
    const nextPosition = (currentPosition + delta + enabled.length) % enabled.length;
    const next = enabled[nextPosition].index;
    setActive(next);
    schedulePreview(next);
  };
  const toggleGroup = (groupKey: string) => {
    clearPreview();
    const collapsing = !collapsedGroups.has(groupKey);
    const nextGroups = new Set(collapsedGroups);
    if (collapsing) nextGroups.add(groupKey); else nextGroups.delete(groupKey);
    setCollapsedGroups(nextGroups);
    if (collapsing && options[active]?.group && groupKeyOf(options[active]) === groupKey) {
      const next = options.findIndex((option, index) => index > active && !option.disabled && !nextGroups.has(groupKeyOf(option)) && (!option.group || groupKeyOf(option) !== groupKey));
      const firstOther = options.findIndex((option) => !option.disabled && !nextGroups.has(groupKeyOf(option)) && (!option.group || groupKeyOf(option) !== groupKey));
      setActive(next >= 0 ? next : firstOther);
    }
  };
  const onKey = (event: KeyboardEvent) => {
    if (disabled) return;
    if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); openMenu(); return; }
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(options[active]); }
    else if (event.key === 'Tab') closeMenu();
  };

  const tone = toned && current?.tone ? current.tone : undefined;
  const previewOption = previewIndex === null ? undefined : options[previewIndex];
  const previewContent = preview && previewOption ? preview(previewOption) : null;
  let lastGroup: string | undefined;
  let lastGroupKey: string | undefined;
  return <>
    <button
      ref={trigger}
      type="button"
      className={`sf-select${tone ? ' toned' : ''}${open ? ' open' : ''} ${className}`}
      style={{ ...style, ...(tone ? { '--tone': tone } as CSSProperties : {}) }}
      role="combobox"
      aria-label={ariaLabel}
      aria-expanded={open}
      aria-controls={listId}
      aria-haspopup="listbox"
      aria-activedescendant={open ? `${listId}-${active}` : undefined}
      disabled={disabled}
      onClick={(event) => { if (stopPropagation) { event.preventDefault(); event.stopPropagation(); } if (open) closeMenu(); else openMenu(); }}
      onKeyDown={onKey}
    >
      <span className={`sf-select-value${current ? '' : ' placeholder'}`}>{current?.label ?? placeholder}</span>
      <svg className="sf-select-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" /></svg>
    </button>
    {open && pos && createPortal(<>
      <div
        ref={menu}
        id={listId}
        className={`sf-select-menu${pos.flip ? ' flip' : ''}`}
        role="listbox"
        aria-label={ariaLabel}
        style={{ left: pos.left, top: pos.top, width: pos.width }}
        onMouseDown={(event) => event.preventDefault()}
        onMouseLeave={scheduleHide}
      >
        {options.map((option, index) => {
          const group = option.group;
          const groupKey = groupKeyOf(option);
          const header = group && (group !== lastGroup || groupKey !== lastGroupKey);
          lastGroup = group;
          lastGroupKey = groupKey;
          const collapsed = isCollapsed(option);
          return <Fragment key={`${option.value}-${index}`}>
            {header && (collapsibleGroups ? <button type="button" tabIndex={-1} className="sf-select-group-toggle" aria-expanded={!collapsed} aria-label={`${collapsed ? '展開' : '收合'}${group}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); toggleGroup(groupKey); }}>
              <span>{group}</span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
            </button> : <div className="sf-select-group">{group}</div>)}
            {!collapsed && <div className={`sf-select-row${group ? ' grouped' : ''}`}>
              <div
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                className={`sf-select-option${index === active ? ' active' : ''}${option.value === value ? ' selected' : ''}${option.disabled ? ' disabled' : ''}`}
                style={option.tone ? { '--tone': option.tone } as CSSProperties : undefined}
                onMouseEnter={() => { setActive(index); schedulePreview(index); }}
                onMouseLeave={scheduleHide}
                onClick={() => choose(option)}
              >
                <span className="sf-select-label">{option.label}</span>
                {option.hint && <small className="sf-select-hint">{option.hint}</small>}
                {option.value === value && <svg className="sf-select-check" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.5 9.5 3.5" /></svg>}
              </div>
            </div>}
          </Fragment>;
        })}
      </div>
      {previewContent && previewPos && <div ref={previewBox} className="sf-select-preview-popover" role="note" onMouseEnter={cancelHide} onMouseLeave={scheduleHide} onMouseDown={(event) => event.preventDefault()} style={{ left: previewPos.left, top: previewPos.top, maxHeight: previewPos.maxHeight }} aria-live="polite">{previewContent}</div>}
    </>, document.body)}
  </>;
}

/** 與「同場連線」相同外觀的開關：膠囊軌道 + 圓鈕 + 文字。整個 App 的開／關設定都用它。 */
export function Switch({ checked, onChange, label, title, disabled, className = '' }: { checked: boolean; onChange: (checked: boolean) => void; label: ReactNode; title?: string; disabled?: boolean; className?: string }) {
  return <button
    type="button"
    role="switch"
    aria-checked={checked}
    title={title}
    disabled={disabled}
    className={`sf-switch${checked ? ' on' : ''} ${className}`}
    onClick={() => onChange(!checked)}
  >
    <span className="sf-switch-track" aria-hidden="true"><span className="sf-switch-knob" /></span>
    <span className="sf-switch-label">{label}</span>
  </button>;
}
