import type { CongestionData } from "../data/congestion-data";
import type { Ridership } from "../data/ridership";
import type { Station } from "../types";
import type { PreparedRoute } from "./fleet";

/** 1량당 정원(명). 실제 정원은 차종마다 다르지만 비교 기준으로 하나를 쓴다. */
const PER_CAR = 160;
/**
 * 색 구간의 상한. 이보다 붐벼도 같은 색으로 보인다.
 * 실측 자료의 최대가 148% 라 그 언저리로 잡아야 색이 고루 쓰인다.
 */
export const MAX_RATIO = 1.6;

/**
 * 노선 구간별 재차인원 추정.
 *
 * 정확한 값은 승객 기종점(OD) 자료가 있어야 나온다. 여기서는 역별 승하차만으로
 * 다음처럼 어림한다.
 *
 *   1. 역 승하차를 그 역이 속한 노선 수로 나눠 노선 몫을 만든다.
 *   2. 그 역에서 타는 사람을 진행 방향 앞쪽 하차 수요에 비례해 배분한다.
 *      아침에 도심 하차가 크면 외곽 승객 대부분이 도심 쪽으로 잡힌다.
 *   3. 구간마다 (탄 사람 − 내린 사람)을 누적한다. 순환선은 기준점이 없으므로
 *      최소값을 빼서 가장 한산한 구간이 0 이 되게 맞춘다.
 *   4. 시간당 통과 인원을 배차 간격으로 나눠 열차 한 편당 인원을 얻는다.
 *
 * 실제 혼잡도와 자릿수는 맞지만(2호선 아침 사당 방향 약 270%) 정확한 수치는 아니다.
 * 서울교통공사 실측값(1~8호선)이 있으면 그쪽을 먼저 쓰고, 없는 노선에서만
 * 이 추정을 쓴다.
 */
export class Congestion {
  /** `${routeId}|${dir}|${hour}` → 구간별 열차 한 편당 인원. */
  private readonly profiles = new Map<string, Float32Array>();
  private readonly routes = new Map<string, PreparedRoute>();
  /** 실측 자료. 있으면 추정보다 먼저 본다. */
  private measured: CongestionData | null = null;

  constructor(routes: PreparedRoute[], stations: Station[], ridership: Ridership) {
    const lineCount = new Map<string, number>();
    for (const s of stations) lineCount.set(s.id, Math.max(1, s.lines.length));

    for (const route of routes) {
      this.routes.set(route.id, route);
      const perTrain = 60 / Math.max(1, route.headway) || 1;
      const trainsPerHour = perTrain;

      for (let hour = 0; hour < 24; hour++) {
        for (const dir of [1, -1] as const) {
          const seg = this.build(route, hour, dir, ridership, lineCount, trainsPerHour);
          this.profiles.set(`${route.id}|${dir}|${hour}`, seg);
        }
      }
    }
  }

  private build(
    route: PreparedRoute,
    hour: number,
    dir: 1 | -1,
    ridership: Ridership,
    lineCount: Map<string, number>,
    trainsPerHour: number,
  ): Float32Array {
    const stops = route.stations;
    const n = stops.length;
    const order = dir === 1 ? stops : [...stops].reverse();

    // 노선 몫으로 나눈 승차·하차
    const on = new Float64Array(n);
    const off = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const flow = ridership.rawFlow(order[k].id);
      if (!flow) continue;
      const w = 1 / (lineCount.get(order[k].id) ?? 1);
      on[k] = (flow.on[hour] ?? 0) * w;
      off[k] = (flow.off[hour] ?? 0) * w;
    }

    // 진행 방향 앞쪽 하차 수요(suffix)와 뒤쪽 승차 공급(prefix)
    const suffOff = new Float64Array(n + 1);
    for (let k = n - 1; k >= 0; k--) suffOff[k] = suffOff[k + 1] + off[k];
    const prefOn = new Float64Array(n + 1);
    for (let k = 0; k < n; k++) prefOn[k + 1] = prefOn[k] + on[k];

    const raw = new Float64Array(n);
    let load = 0;
    let min = 0;
    for (let k = 0; k < n; k++) {
      const ahead = suffOff[k + 1];
      const behind = suffOff[0] - suffOff[k + 1];
      const boardShare = ahead + behind > 0 ? ahead / (ahead + behind) : 0.5;

      const upstream = prefOn[k];
      const downstream = prefOn[n] - prefOn[k + 1];
      const alightShare = upstream + downstream > 0 ? upstream / (upstream + downstream) : 0.5;

      load += on[k] * boardShare - off[k] * alightShare;
      raw[k] = load;
      if (load < min) min = load;
    }

    // seg[i] = 원래 인덱스 i 와 i+1 사이 구간의 열차 한 편당 인원
    const seg = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const perTrain = (raw[k] - min) / trainsPerHour;
      const index = dir === 1 ? k : n - 2 - k;
      if (index >= 0 && index < n) seg[index] = perTrain;
    }
    return seg;
  }

  setMeasured(data: CongestionData | null): void {
    this.measured = data;
  }

  /** 진행 방향 기준 열차가 마지막으로 지난 역. */
  private lastStopIndex(route: PreparedRoute, dir: 1 | -1, along: number): number {
    const stops = route.stations;
    // 역은 along 오름차순이라 이분 탐색으로 구간을 찾는다.
    let lo = 0;
    let hi = stops.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (stops[mid].along <= along) lo = mid;
      else hi = mid - 1;
    }
    // 역방향으로 달리면 방금 지난 역은 한 칸 뒤가 아니라 앞쪽이다.
    if (dir === -1 && lo + 1 < stops.length && stops[lo].along < along) lo += 1;
    return lo;
  }

  /**
   * 노선 위 한 지점의 혼잡도. 1 이면 정원 만석.
   * 실측값이 있으면 그것을, 없으면 추정값을 쓴다. 둘 다 없으면 null 이라
   * 호출하는 쪽에서 원래 색을 쓰면 된다.
   */
  ratioAt(
    routeId: string,
    dir: 1 | -1,
    hour: number,
    along: number,
    date?: Date,
  ): number | null {
    const route = this.routes.get(routeId);
    if (!route) return null;

    const index = this.lastStopIndex(route, dir, along);

    if (this.measured && date) {
      const stop = route.stations[index];
      const real = stop && this.measured.ratioAt(stop.id, route.line, dir, date);
      if (real !== null && real !== undefined) return real;
    }

    const seg = this.profiles.get(`${routeId}|${dir}|${Math.floor(hour) % 24}`);
    if (!seg) return null;

    const capacity = Math.max(1, route.cars * PER_CAR);
    return seg[index] / capacity;
  }

  /** 그 노선에 실측값이 있는지. 화면에 출처를 알릴 때 쓴다. */
  isMeasured(routeId: string, dir: 1 | -1, along: number, date: Date): boolean {
    const route = this.routes.get(routeId);
    if (!route || !this.measured) return false;
    const stop = route.stations[this.lastStopIndex(route, dir, along)];
    return Boolean(stop && this.measured.ratioAt(stop.id, route.line, dir, date) !== null);
  }
}

/** 혼잡도 → 색. 여유는 초록, 만석 부근은 노랑, 넘어서면 주황·빨강. */
export function congestionColor(ratio: number): string {
  const stops: Array<[number, [number, number, number]]> = [
    [0.2, [76, 175, 125]],
    [0.6, [170, 196, 96]],
    [0.9, [226, 190, 84]],
    [1.2, [232, 143, 62]],
    [MAX_RATIO, [216, 60, 48]],
  ];
  const v = Math.max(stops[0][0], Math.min(MAX_RATIO, ratio));

  for (let i = 1; i < stops.length; i++) {
    if (v > stops[i][0]) continue;
    const [a, ca] = stops[i - 1];
    const [b, cb] = stops[i];
    const t = (v - a) / (b - a);
    const c = ca.map((x, k) => Math.round(x + (cb[k] - x) * t));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  const last = stops[stops.length - 1][1];
  return `rgb(${last[0]},${last[1]},${last[2]})`;
}

/**
 * 사람이 읽는 혼잡도 표기.
 * 100% 가 정원이라는 서울교통공사 기준에 맞춰 나눴다.
 */
export function congestionLabel(ratio: number): string {
  const percent = Math.round(ratio * 100);
  if (percent < 45) return "여유";
  if (percent < 80) return "보통";
  if (percent < 110) return "혼잡";
  if (percent < 140) return "매우 혼잡";
  return "극심";
}
