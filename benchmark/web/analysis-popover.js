let popoverSequence = 0;

/** Clamp an anchored analysis panel to the viewport, flipping above when below has less room. */
export function analysisPopoverPlacement(anchor, width, height, viewportWidth, viewportHeight) {
  const inset = 16,
    gap = 6;
  const below = viewportHeight - anchor.bottom - gap - inset,
    above = anchor.top - gap - inset;
  const top = below < height && above > below ? anchor.top - gap - height : anchor.bottom + gap;
  return {
    left: Math.max(inset, Math.min(anchor.left, viewportWidth - width - inset)),
    top: Math.max(inset, Math.min(top, viewportHeight - height - inset))
  };
}

/** Use native popover top-layer dismissal when available, with the same bounded manual fallback. */
export function createAnalysisPopover(trigger, panel, { width = 340, maxHeight = Infinity, onDismiss = () => {} } = {}) {
  const native = typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'popover');
  const anchorName = `--analysis-popover-${++popoverSequence}`;
  const anchorPositioning = native && typeof CSS !== 'undefined' && CSS.supports('position-area: block-end span-inline-end');
  let open = false;
  if (native) panel.setAttribute('popover', 'auto');
  if (anchorPositioning) {
    trigger.style.setProperty('anchor-name', anchorName);
    panel.style.setProperty('position-anchor', anchorName);
  }
  function position() {
    if (!open) return;
    const inset = 16,
      gap = 6;
    const availableWidth = Math.max(0, window.innerWidth - inset * 2);
    const availableHeight = Math.max(0, Math.min(maxHeight, window.innerHeight - inset * 2));
    Object.assign(panel.style, {
      width: `${Math.min(width, availableWidth)}px`,
      maxWidth: `${availableWidth}px`,
      maxHeight: `${availableHeight}px`
    });
    const anchor = trigger.getBoundingClientRect(),
      bounds = panel.getBoundingClientRect();
    const placement = analysisPopoverPlacement(anchor, bounds.width, bounds.height, window.innerWidth, window.innerHeight);
    // Native anchor flips handle roomy layouts. The manual fallback also handles panels
    // taller than either side of their anchor, including short embedded host windows.
    const fitsSide = Math.max(window.innerHeight - anchor.bottom - gap - inset, anchor.top - gap - inset) >= bounds.height;
    const fitsInline =
      (anchor.left >= inset && anchor.left + bounds.width <= window.innerWidth - inset) ||
      (anchor.right <= window.innerWidth - inset && anchor.right - bounds.width >= inset);
    panel.dataset.anchorLayout = String(anchorPositioning && fitsSide && fitsInline);
    Object.assign(panel.style, { left: `${placement.left}px`, top: `${placement.top}px` });
  }
  function setOpen(next, { focus = false } = {}) {
    if (open === next) {
      if (open) position();
      return;
    }
    open = next;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) {
      panel.hidden = false;
      if (native) panel.showPopover();
      position();
      if (focus) panel.querySelector('button, input, [tabindex="0"]')?.focus({ preventScroll: true });
    } else {
      if (native && panel.matches(':popover-open')) panel.hidePopover();
      panel.hidden = true;
    }
  }
  function dismiss(restoreFocus) {
    if (!open) return;
    setOpen(false);
    if (restoreFocus) trigger.focus({ preventScroll: true });
    onDismiss();
  }
  panel.addEventListener('toggle', event => {
    if (event.newState === 'closed' && open) dismiss(false);
  });
  document.addEventListener('pointerdown', event => {
    if (open && !panel.contains(event.target) && !trigger.contains(event.target)) dismiss(false);
  });
  document.addEventListener('keydown', event => {
    if (open && event.key === 'Escape') {
      dismiss(true);
      event.preventDefault();
      event.stopPropagation();
    }
  });
  window.addEventListener('resize', position);
  window.addEventListener(
    'scroll',
    event => {
      if (!panel.contains(event.target)) position();
    },
    true
  );
  return {
    setOpen,
    position,
    close: () => dismiss(true),
    get isOpen() {
      return open;
    }
  };
}
