const casesContainerId = 'cases';

export function initXrayMotion(): () => void {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reducedMotion.matches) {
    return () => undefined;
  }

  const title = document.getElementById('hero-title');
  title?.classList.add('hero-scanner-once');

  const eventNodes = document.querySelectorAll<HTMLElement>('[data-system-event]');
  let frameId = 0;
  let index = 0;
  let lastTick = 0;

  const tick = (timestamp: number): void => {
    if (document.hidden) {
      frameId = 0;
      return;
    }

    if (timestamp - lastTick > 1400) {
      lastTick = timestamp;
      for (const node of eventNodes) {
        node.classList.remove('is-active');
      }

      const active = eventNodes[index % eventNodes.length];
      active?.classList.add('is-active');
      index += 1;
    }

    frameId = window.requestAnimationFrame(tick);
  };

  frameId = window.requestAnimationFrame(tick);

  const onVisibility = (): void => {
    if (document.hidden && frameId) {
      window.cancelAnimationFrame(frameId);
      frameId = 0;
      return;
    }

    if (!document.hidden && !frameId) {
      lastTick = 0;
      frameId = window.requestAnimationFrame(tick);
    }
  };

  document.addEventListener('visibilitychange', onVisibility);
  bindCaseHoldXray();

  return () => {
    if (frameId) {
      window.cancelAnimationFrame(frameId);
    }

    document.removeEventListener('visibilitychange', onVisibility);
    unbindCaseHoldXray();

    for (const node of eventNodes) {
      node.classList.remove('is-active');
    }

    title?.classList.remove('hero-scanner-once');
  };
}

function bindCaseHoldXray(): void {
  const container = document.getElementById(casesContainerId);
  if (!container) {
    return;
  }

  container.addEventListener('pointerdown', onCasePointerDown);
  window.addEventListener('pointerup', clearCaseXray);
  window.addEventListener('pointercancel', clearCaseXray);
}

function unbindCaseHoldXray(): void {
  const container = document.getElementById(casesContainerId);
  if (!container) {
    return;
  }

  container.removeEventListener('pointerdown', onCasePointerDown);
  window.removeEventListener('pointerup', clearCaseXray);
  window.removeEventListener('pointercancel', clearCaseXray);
  clearCaseXray();
}

function onCasePointerDown(event: PointerEvent): void {
  const caseCard = (event.target as HTMLElement).closest<HTMLElement>('[data-case-xray]');
  if (!caseCard) {
    return;
  }

  clearCaseXray();
  caseCard.dataset.xrayActive = 'true';
}

function clearCaseXray(): void {
  const activeCards = document.querySelectorAll<HTMLElement>('[data-case-xray][data-xray-active]');
  for (const caseCard of activeCards) {
    delete caseCard.dataset.xrayActive;
  }
}
