export interface Coordinates { latitude: number; longitude: number }

export function haversineDistanceM(from: Coordinates, to: Coordinates): number {
  for (const point of [from, to]) {
    if (!Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 || !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180) throw new RangeError('Invalid coordinates');
  }
  const radians = Math.PI / 180;
  const lat = (to.latitude - from.latitude) * radians;
  const lon = (to.longitude - from.longitude) * radians;
  const a = Math.sin(lat / 2) ** 2 + Math.cos(from.latitude * radians) * Math.cos(to.latitude * radians) * Math.sin(lon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}
