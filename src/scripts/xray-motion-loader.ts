let motionCleanup: (() => void) | undefined;
let motionScheduled = false;

export function scheduleXrayMotion(): void {
  if (motionScheduled) {
    return;
  }

  motionScheduled = true;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reducedMotion.matches) {
    return;
  }

  const start = (): void => {
    void import('./xray-motion').then((module) => {
      motionCleanup = module.initXrayMotion();
    });
  };

  const idleCallback = window.requestIdleCallback;
  if (idleCallback) {
    idleCallback(start, { timeout: 2000 });
    return;
  }

  setTimeout(start, 300);
}

export function cancelXrayMotion(): void {
  motionCleanup?.();
  motionCleanup = undefined;
  motionScheduled = false;
}
