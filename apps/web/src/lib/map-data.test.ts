import { describe, expect, it } from 'vitest';
import { boundaryGeometry } from './map-data';

const ring = [[73, 18], [74, 18], [74, 19], [73, 18]];

describe('ward boundary validation', () => {
  it('accepts a polygon and its interior rings without changing coordinates', () => {
    const geometry = { type: 'Polygon', coordinates: [ring, [[73.5, 18.1], [73.6, 18.1], [73.6, 18.2], [73.5, 18.1]]] };
    expect(boundaryGeometry(geometry)).toEqual(geometry);
  });
  it('accepts a GeoJSON Feature containing a MultiPolygon', () => {
    const geometry = { type: 'MultiPolygon', coordinates: [[ring], [ring]] };
    expect(boundaryGeometry({ type: 'Feature', properties: { name: 'Ward' }, geometry })).toEqual(geometry);
  });
  it('preserves finite optional altitude values', () => {
    const geometry = { type: 'Polygon', coordinates: [ring.map(([lng, lat]) => [lng, lat, 10])] };
    expect(boundaryGeometry(geometry)).toEqual(geometry);
  });
  it.each([
    null,
    {},
    { type: 'Feature', geometry: null },
    { type: 'Point', coordinates: [73, 18] },
    { type: 'Polygon', coordinates: [] },
    { type: 'Polygon', coordinates: [[]] },
    { type: 'MultiPolygon', coordinates: [] },
    { type: 'MultiPolygon', coordinates: [[ring], []] },
    { type: 'Polygon', coordinates: [ring.slice(0, 3)] },
    { type: 'Polygon', coordinates: [[[73, 18], [74, 18], [74, 19], [73, 19]]] },
    { type: 'Polygon', coordinates: [ring.map(([lng, lat]) => [String(lng), lat])] },
    { type: 'Polygon', coordinates: [ring.map(([, lat]) => [181, lat])] },
    { type: 'Polygon', coordinates: [ring.map(([lng]) => [lng, 91])] },
    { type: 'Polygon', coordinates: [ring.map(([lng]) => [lng, Number.NaN])] },
    { type: 'Polygon', coordinates: [ring.map(([lng, lat]) => [lng, lat, Infinity])] },
    { type: 'Polygon', coordinates: [ring.map(([lng, lat]) => [lng, lat, 0, 0])] },
    { type: 'Polygon', coordinates: [ring, [[73, 18]]] },
  ])('rejects malformed or unsupported geometry %#', value => {
    expect(boundaryGeometry(value)).toBeNull();
  });
});
