import { record } from './data';

type Position = [number, number] | [number, number, number];
export type BoundaryGeometry =
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] };

function isPosition(value: unknown): value is Position {
  return Array.isArray(value)
    && (value.length === 2 || value.length === 3)
    && value.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate))
    && Math.abs(value[0]) <= 180
    && Math.abs(value[1]) <= 90;
}

function isRing(value: unknown): value is Position[] {
  if (!Array.isArray(value) || value.length < 4 || !value.every(isPosition)) return false;
  const first = value[0]; const last = value[value.length - 1];
  return first.length === last.length && first.every((coordinate, index) => coordinate === last[index]);
}

function isPolygon(value: unknown): value is Position[][] {
  return Array.isArray(value) && value.length > 0 && value.every(isRing);
}

// Reject malformed boundaries rather than silently dropping vertices or closing rings.
export function boundaryGeometry(value: unknown): BoundaryGeometry | null {
  const boundary = record(value);
  const geometry = boundary.type === 'Feature' ? record(boundary.geometry) : boundary;
  if (geometry.type === 'Polygon' && isPolygon(geometry.coordinates)) {
    return { type: 'Polygon', coordinates: geometry.coordinates };
  }
  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)
    && geometry.coordinates.length > 0 && geometry.coordinates.every(isPolygon)) {
    return { type: 'MultiPolygon', coordinates: geometry.coordinates };
  }
  return null;
}
