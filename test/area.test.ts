import { assert, describe, it } from '@effect/vitest';
import { contains, isTile, overlaps, tileAt, tileBounds, unwrap } from '../src/area.ts';

describe('area tiles', () => {
  it('finds the tile containing a point and its bounds contain the point', () => {
    // The Ferry Building, San Francisco, at zoom 14.
    const { x, y } = tileAt(14, -122.3935, 37.7955);
    assert.deepStrictEqual({ x, y }, { x: 2621, y: 6331 });
    const b = tileBounds(14, x, y);
    assert.isTrue(contains(b, -122.3935, 37.7955));
    assert.isBelow(b.east - b.west, 0.0221);
    assert.isAbove(b.north, b.south);
  });

  it('clamps points beyond the Web Mercator latitude limit and the antimeridian', () => {
    assert.deepStrictEqual(tileAt(3, 180, 89.9), { x: 7, y: 0 });
    assert.deepStrictEqual(tileAt(3, -180, -89.9), { x: 0, y: 7 });
    assert.isTrue(isTile(3, 7, 7));
    assert.isFalse(isTile(3, 8, 0));
  });

  it('treats bounds with west east of east as crossing the antimeridian', () => {
    const pacific = { west: 170, south: -10, east: -170, north: 10 };
    assert.isTrue(contains(pacific, 179, 0));
    assert.isTrue(contains(pacific, -179, 0));
    assert.isFalse(contains(pacific, 0, 0));
    assert.deepStrictEqual(unwrap(pacific), [
      { west: 170, south: -10, east: 180, north: 10 },
      { west: -180, south: -10, east: -170, north: 10 },
    ]);
    assert.isTrue(overlaps(pacific, { west: -175, south: -1, east: -172, north: 1 }));
    assert.isFalse(overlaps(pacific, { west: -160, south: -1, east: -150, north: 1 }));
  });
});
