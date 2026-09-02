import { describe, expect, it } from 'vitest';
import {
  clamp,
  lagAlpha,
  lensSizeForCoarsePointer,
  percentFromPointer,
  shouldUseReducedMotion,
} from '../../src/scripts/xray-math';

describe('xray-math', () => {
  it('clamps values', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });

  it('computes lag alpha from delta', () => {
    expect(lagAlpha(75, 75)).toBeGreaterThan(0);
    expect(lagAlpha(75, 75)).toBeLessThan(1);
  });

  it('maps pointer to percent inside rect', () => {
    const rect = { left: 0, top: 0, width: 200, height: 100 } as DOMRect;
    expect(percentFromPointer(100, 50, rect)).toEqual({ x: 50, y: 50 });
    expect(percentFromPointer(-10, 150, rect)).toEqual({ x: 0, y: 100 });
  });

  it('returns smaller lens on coarse pointer', () => {
    expect(lensSizeForCoarsePointer(true)).toBe('14rem');
    expect(lensSizeForCoarsePointer(false)).toBe('18rem');
  });

  it('reads reduced motion preference', () => {
    const media = { matches: true } as MediaQueryList;
    expect(shouldUseReducedMotion(media)).toBe(true);
  });
});
