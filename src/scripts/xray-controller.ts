import {
  LENS_LAG_MS,
  lagAlpha,
  lensSizeForCoarsePointer,
  percentFromPointer,
  shouldUseReducedMotion,
} from './xray-math';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

function trapFocus(stage: HTMLElement): () => void {
  const focusables = Array.from(
    stage.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => !element.hasAttribute('disabled'));

  if (focusables.length === 0) {
    return () => undefined;
  }

  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  const onTrapKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') {
      return;
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  stage.addEventListener('keydown', onTrapKeyDown);
  first.focus();

  return () => {
    stage.removeEventListener('keydown', onTrapKeyDown);
  };
}

export function initXrayController(root: HTMLElement): () => void {
  const stage = root.querySelector<HTMLElement>('[data-xray-stage]');
  const maskWrap = root.querySelector<HTMLElement>('[data-xray-mask]');
  const toggle = root.querySelector<HTMLButtonElement>('[data-xray-toggle]');
  const status = root.querySelector<HTMLElement>('[data-xray-status]');

  if (!stage || !maskWrap || !toggle || !status) {
    return () => undefined;
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const coarsePointer = window.matchMedia('(pointer: coarse)');
  let mode: 'surface' | 'system' = 'surface';
  let targetX = 62;
  let targetY = 48;
  let currentX = targetX;
  let currentY = targetY;
  let rafId = 0;
  let lastFrame = 0;
  let dragging = false;
  let previousFocus: HTMLElement | null = null;

  const setStatus = (value: string): void => {
    status.textContent = value;
  };

  const applyVars = (): void => {
    maskWrap.style.setProperty('--xray-x', `${currentX}%`);
    maskWrap.style.setProperty('--xray-y', `${currentY}%`);
    maskWrap.style.setProperty(
      '--xray-size',
      lensSizeForCoarsePointer(coarsePointer.matches),
    );
  };

  const setMode = (next: 'surface' | 'system'): void => {
    mode = next;
    stage.dataset.mode = next;
    toggle.setAttribute('aria-expanded', String(next === 'system'));
    toggle.textContent =
      next === 'system' ? 'Вернуть поверхность' : toggle.dataset.label ?? toggle.textContent;
  };

  let releaseFocusTrap: (() => void) | undefined;

  const openSystem = (): void => {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMode('system');
    releaseFocusTrap = trapFocus(stage);
  };

  const closeSystem = (): void => {
    setMode('surface');
    releaseFocusTrap?.();
    releaseFocusTrap = undefined;
    previousFocus?.focus();
    previousFocus = null;
  };

  const frame = (timestamp: number): void => {
    rafId = 0;
    if (lastFrame === 0) {
      lastFrame = timestamp;
    }

    const delta = timestamp - lastFrame;
    lastFrame = timestamp;

    if (!reducedMotion.matches && mode === 'surface') {
      const alpha = lagAlpha(delta, LENS_LAG_MS);
      currentX = currentX + (targetX - currentX) * alpha;
      currentY = currentY + (targetY - currentY) * alpha;
      applyVars();
    }

    if (dragging || mode === 'surface') {
      rafId = window.requestAnimationFrame(frame);
    }
  };

  const ensureLoop = (): void => {
    if (!rafId && !reducedMotion.matches && mode === 'surface') {
      lastFrame = 0;
      rafId = window.requestAnimationFrame(frame);
    }
  };

  const updateTarget = (clientX: number, clientY: number): void => {
    const rect = stage.getBoundingClientRect();
    const point = percentFromPointer(clientX, clientY, rect);
    targetX = point.x;
    targetY = point.y;

    if (reducedMotion.matches) {
      currentX = targetX;
      currentY = targetY;
      applyVars();
      return;
    }

    ensureLoop();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (mode !== 'surface' || reducedMotion.matches) {
      return;
    }

    updateTarget(event.clientX, event.clientY);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (mode !== 'surface') {
      return;
    }

    dragging = true;
    stage.setPointerCapture(event.pointerId);
    updateTarget(event.clientX, event.clientY);
    ensureLoop();
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }

    dragging = false;
    if (stage.hasPointerCapture(event.pointerId)) {
      stage.releasePointerCapture(event.pointerId);
    }
  };

  const onToggle = (): void => {
    if (mode === 'system') {
      closeSystem();
      return;
    }

    openSystem();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && mode === 'system') {
      event.preventDefault();
      closeSystem();
    }
  };

  const onVisibility = (): void => {
    if (document.hidden && rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };

  toggle.dataset.label = toggle.textContent ?? '';
  toggle.setAttribute('aria-controls', stage.id);
  toggle.setAttribute('aria-expanded', 'false');
  applyVars();
  setStatus('x-ray ready');

  stage.addEventListener('pointermove', onPointerMove, { passive: true });
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerUp);
  toggle.addEventListener('click', onToggle);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('visibilitychange', onVisibility);

  if (!shouldUseReducedMotion(reducedMotion)) {
    ensureLoop();
  }

  return () => {
    if (rafId) {
      window.cancelAnimationFrame(rafId);
    }

    stage.removeEventListener('pointermove', onPointerMove);
    stage.removeEventListener('pointerdown', onPointerDown);
    stage.removeEventListener('pointerup', onPointerUp);
    stage.removeEventListener('pointercancel', onPointerUp);
    toggle.removeEventListener('click', onToggle);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('visibilitychange', onVisibility);
    releaseFocusTrap?.();
  };
}
