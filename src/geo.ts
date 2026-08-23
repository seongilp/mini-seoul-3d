export function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function headingDeg(from: [number, number], to: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(to[0] - from[0])) * Math.cos(toRad(to[1]));
  const x =
    Math.cos(toRad(from[1])) * Math.sin(toRad(to[1])) -
    Math.sin(toRad(from[1])) * Math.cos(toRad(to[1])) * Math.cos(toRad(to[0] - from[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function cumulative(coords: [number, number][]): number[] {
  const dist = [0];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversine(coords[i - 1], coords[i]);
    dist.push(total);
  }
  return dist;
}

export function pointAlong(
  coords: [number, number][],
  dist: number[],
  length: number,
  along: number,
): { coord: [number, number]; heading: number } {
  if (coords.length < 2 || length <= 0) {
    return { coord: coords[0], heading: 0 };
  }
  let d = along % length;
  if (d < 0) d += length;
  let lo = 0;
  let hi = dist.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] < d) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const a = coords[i - 1];
  const b = coords[i];
  const span = dist[i] - dist[i - 1] || 1;
  const t = (d - dist[i - 1]) / span;
  return {
    coord: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    heading: headingDeg(a, b),
  };
}
