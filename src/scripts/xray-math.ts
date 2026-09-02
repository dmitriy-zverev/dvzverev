export const LENS_LAG_MS = 75;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function lerp(current: number, target: number, alpha: number): number {
  return current + (target - current) * alpha;
}

export function lagAlpha(deltaMs: number, lagMs: number): number {
  const safeLag = Math.max(lagMs, 1);
  return 1 - Math.exp(-deltaMs / safeLag);
}

export function percentFromPointer(
  clientX: number,
  clientY: number,
  rect: DOMRect,
): { x: number; y: number } {
  const x = clamp(((clientX - rect.left) / rect.width) * 100, 0, 100);
  const y = clamp(((clientY - rect.top) / rect.height) * 100, 0, 100);
  return { x, y };
}

export function lensSizeForCoarsePointer(isCoarse: boolean): string {
  return isCoarse ? '14rem' : '18rem';
}

export function shouldUseReducedMotion(mediaQuery: MediaQueryList): boolean {
  return mediaQuery.matches;
}
