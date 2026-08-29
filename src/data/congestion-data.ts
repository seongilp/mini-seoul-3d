import { dayTypeOf, nowMinutes, type DayType } from "./timetable";

/**
 * 서울교통공사가 실측한 역·방향·시간대별 혼잡도.
 * scripts/build-congestion.mjs 가 만든다.
 *
 * 값은 백분율이고 100 이 정원이다. 1~8호선만 있어서, 없는 노선은 조회가
 * null 을 돌려주고 호출하는 쪽이 추정값으로 물러난다.
 */

type Direction = "forward" | "backward";

type StationTable = Record<string, Partial<Record<DayType, Partial<Record<Direction, number[]>>>>>;

type CongestionFile = {
  source: string;
  /** "05:30" 부터 30분 간격. 마지막 두 개(00:00, 00:30)는 다음 날이다. */
  times: string[];
  stations: Record<string, StationTable>;
};

/** 첫 구간의 시작(분). 05:30. */
const FIRST_MINUTE = 5 * 60 + 30;
const STEP_MINUTES = 30;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class CongestionData {
  readonly source: string;
  private readonly stations: Record<string, StationTable>;
  private readonly count: number;

  constructor(file: CongestionFile) {
    this.source = file.source;
    this.stations = file.stations;
    this.count = file.times.length;
  }

  has(stationId: string, line: string): boolean {
    return Boolean(this.stations[stationId]?.[line]);
  }

  /**
   * 그 역을 그 방향으로 떠나는 열차의 혼잡도(0~1.5 남짓, 1 = 정원).
   * 자료가 없으면 null.
   */
  ratioAt(stationId: string, line: string, dir: 1 | -1, date: Date): number | null {
    const byDay = this.stations[stationId]?.[line];
    if (!byDay) return null;

    const series = byDay[dayTypeOf(date)]?.[dir === 1 ? "forward" : "backward"];
    if (!series || series.length === 0) return null;

    // 30분 구간 사이를 이어 붙여 시각이 흐를 때 값이 뚝뚝 끊기지 않게 한다.
    const position = (nowMinutes(date) - FIRST_MINUTE) / STEP_MINUTES;
    if (position < -1 || position > this.count) return null;

    const base = Math.floor(position);
    const t = position - base;
    const a = series[Math.max(0, Math.min(this.count - 1, base))];
    const b = series[Math.max(0, Math.min(this.count - 1, base + 1))];
    if (a === undefined || b === undefined) return null;

    return lerp(a, b, t) / 100;
  }
}

/** 실패해도 추정값으로 돌아가면 되므로 null 을 돌려준다. */
export async function loadCongestionData(): Promise<CongestionData | null> {
  try {
    const res = await fetch("/data/congestion.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new CongestionData((await res.json()) as CongestionFile);
  } catch (error) {
    console.warn("congestion data load failed", error);
    return null;
  }
}
