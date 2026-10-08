/**
 * Shared sliding selector thumb for tab, radio and filter groups.
 * Existing app groups keep their semantic state (`active`/ARIA); the thumb is decorative.
 */
const GROUP_SELECTOR = [
  '[data-seg]', '[data-segmented]', '[role="tablist"]', '[role="radiogroup"]', '[role="group"]',
  '.record-filters', '.gt-speed', '.gp-types', '.bible-tabs', '.report-tabs', '.template-chips', '.seg-chips', '.kind-row',
].join(',');
const CHOICE_SELECTOR = 'button, [role="tab"], [role="radio"]';
const ACTIVE_SELECTOR = '.active, [aria-pressed="true"], [aria-selected="true"], [aria-checked="true"]';
const thumbs = new Map<HTMLElement, ResizeObserver>();
const lastActive = new WeakMap<HTMLElement, HTMLElement>();
let mutationObserver: MutationObserver | null = null;
let resizeFrame = 0;
let pendingAnimation = false;
let resizeListenerInstalled = false;

function directChoices(group: HTMLElement): HTMLElement[] {
  return Array.from(group.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child.matches(CHOICE_SELECTOR));
}

function selectedChoice(group: HTMLElement): HTMLElement | undefined {
  return directChoices(group).find((choice) => choice.matches(ACTIVE_SELECTOR));
}




function observeGroup(group: HTMLElement): void {
  if (typeof ResizeObserver === 'undefined') return;
  let observer = thumbs.get(group);
  if (!observer) {
    observer = new ResizeObserver(() => scheduleSync(false));
    thumbs.set(group, observer);
    observer.observe(group);
  }
  directChoices(group).forEach((choice) => observer!.observe(choice));
}

function cleanupObservers(): void {
  for (const [group, observer] of thumbs) {
    if (group.isConnected) continue;
    observer.disconnect();
    thumbs.delete(group);
  }
}

function scheduleSync(animate: boolean): void {
  pendingAnimation ||= animate;
  if (resizeFrame || typeof requestAnimationFrame === 'undefined') return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    const shouldAnimate = pendingAnimation;
    pendingAnimation = false;
    syncSegmentThumbs(document, shouldAnimate);
  });
}

function installObservers(): void {
  if (typeof document === 'undefined') return;
  if (!mutationObserver && typeof MutationObserver !== 'undefined') {
    mutationObserver = new MutationObserver((records) => {
      const shouldSync = records.some((record) => {
        if (record.type === 'attributes') {
          const target = record.target;
          return target instanceof Element && (target.matches(GROUP_SELECTOR) || !!target.parentElement?.matches(GROUP_SELECTOR));
        }
        const insertedThumbOnly = record.addedNodes.length > 0 && record.removedNodes.length === 0
          && Array.from(record.addedNodes).every((node) => node instanceof Element && node.classList.contains('seg-thumb'));
        return !insertedThumbOnly;
      });
      if (shouldSync) scheduleSync(true);
    });
    mutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'aria-pressed', 'aria-selected', 'aria-checked', 'hidden', 'data-seg-ignore'],
    });
  }
  if (!resizeListenerInstalled) {
    window.addEventListener('resize', () => scheduleSync(false), { passive: true });
    resizeListenerInstalled = true;
    document.fonts?.ready.then(() => scheduleSync(false)).catch(() => undefined);
  }
}

/**
 * Align the thumb to each selected child. New groups are discovered by a shared
 * MutationObserver; ResizeObserver keeps widths and wrapping correct at breakpoints.
 */
export function syncSegmentThumbs(root: ParentNode = document, animate = true): void {
  if (typeof document === 'undefined') return;
  installObservers();
  const groups: HTMLElement[] = [];
  if (root instanceof Element && root.matches(GROUP_SELECTOR)) groups.push(root as HTMLElement);
  groups.push(...root.querySelectorAll<HTMLElement>(GROUP_SELECTOR));

  for (const group of groups) {
    if (group.hasAttribute('data-seg-ignore')) {
      group.querySelector(':scope > .seg-thumb')?.remove();
      thumbs.get(group)?.disconnect();
      thumbs.delete(group);
      lastActive.delete(group);
      continue;
    }
    const choices = directChoices(group);
    if (!choices.length) continue;
    const active = selectedChoice(group);
    let thumb = group.querySelector<HTMLElement>(':scope > .seg-thumb');
    const firstPosition = !thumb || thumb.dataset.positioned !== 'true';
    if (!thumb) {
      thumb = document.createElement('span');
      thumb.className = 'seg-thumb';
      thumb.setAttribute('aria-hidden', 'true');
      thumb.style.transition = 'none';
      group.prepend(thumb);
    }
    observeGroup(group);
    if (!active) {
      thumb.style.opacity = '0';
      lastActive.delete(group);
      cleanupObservers();
      continue;
    }
    const activeChanged = lastActive.get(group) !== active;
    if (!firstPosition && !activeChanged && animate) continue;
    const groupRect = group.getBoundingClientRect();
    const choiceRect = active.getBoundingClientRect();
    if (!groupRect.width || !groupRect.height || !choiceRect.width || !choiceRect.height) {
      thumb.style.opacity = '0';
      continue;
    }
    const nextWidth = `${choiceRect.width}px`;
    const nextHeight = `${choiceRect.height}px`;
    // Write the exact form the browser serializes back ("0px"), otherwise every later sync sees a
    // phantom geometry change and snaps the thumb with transition:none, killing the slide.
    const nextTransform = `translate3d(${choiceRect.left - groupRect.left - group.clientLeft}px, ${choiceRect.top - groupRect.top - group.clientTop}px, 0px)`;
    thumb.style.opacity = '1';
    const geometryChanged = thumb.style.width !== nextWidth || thumb.style.height !== nextHeight || thumb.style.transform !== nextTransform;
    if (!geometryChanged) { lastActive.set(group, active); continue; }
    // A concurrent resize/observer sync must not consume a fresh selection without its slide.
    // Only snap on first placement or a genuine resize; mid-slide re-syncs keep the running transition.
    const placeImmediately = firstPosition || (!activeChanged && thumb.getAnimations().length === 0 && !animate);
    if (placeImmediately) thumb.style.transition = 'none';
    thumb.style.opacity = '1';
    thumb.style.width = nextWidth;
    thumb.style.height = nextHeight;
    thumb.style.transform = nextTransform;
    thumb.dataset.positioned = 'true';
    lastActive.set(group, active);
    if (placeImmediately) requestAnimationFrame(() => { if (thumb?.isConnected) thumb.style.transition = ''; });
  }
  cleanupObservers();
}
