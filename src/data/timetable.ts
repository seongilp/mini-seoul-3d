/**
 * 역별 첫차·막차 시각. scripts/build-timetable.mjs 가 만든다.
 *
 * 서울교통공사가 1~9호선만 시간표를 제공해서 나머지 노선은 데이터가 없다.
 * 없는 노선은 이 모듈의 조회 함수들이 null 을 돌려주므로, 호출하는 쪽에서
 * 시간표 없이도 동작해야 한다.
 */

/** [첫차, 첫차 종착역, 막차, 막차 종착역]. 시각은 "05:36", 자정 이후는 "24:53". */
export type Edge = readonly [string, string, string, string];

export type DayType = "weekday" | "saturday" | "holiday";

export type Direction = "up" | "down";

type StationTable = Record<string, Partial<Record<DayType, Partial<Record<Direction, Edge>>>>>;

type TimetableFile = {
  generatedAt: string;
  stations: Record<string, StationTable>;
};

/**
 * 날짜가 고정된 공휴일(월-일). 음력 명절(설·추석)과 대체공휴일은 해마다 달라
 * 여기에 없다. 토요일과 공휴일 시간표는 대부분 같아서 영향이 크지 않다.
 */
const FIXED_HOLIDAYS = new Set([
  "1-1",
  "3-1",
  "5-5",
  "6-6",
  "8-15",
  "10-3",
  "10-9",
  "12-25",
]);

/**
 * 시간표는 서울 시각 기준이다. 브라우저 시간대가 무엇이든 같은 판단을 하도록
 * 서울 기준 날짜·시각 조각을 뽑아 쓴다.
 */
const SEOUL_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  weekday: "short",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

type SeoulTime = { month: number; day: number; weekday: number; hour: number; minute: number };

export function seoulTime(date: Date): SeoulTime {
  const parts = SEOUL_PARTS.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  // 자정은 "24" 로 나오는 환경이 있어 24로 나누어 0 으로 맞춘다.
  const hour = Number(get("hour")) % 24;
  return {
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 1,
    hour,
    minute: Number(get("minute")),
  };
}

export function dayTypeOf(date: Date): DayType {
  const t = seoulTime(date);
  if (FIXED_HOLIDAYS.has(`${t.month}-${t.day}`)) return "holiday";
  if (t.weekday === 0) return "holiday";
  if (t.weekday === 6) return "saturday";
  return "weekday";
}

/** "24:53" → 1493. 운행일 05시를 기준으로 한 분 단위 값. */
export function toMinutes(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 현재 시각을 운행일 기준 분으로 바꾼다.
 * 새벽 0~4시는 전날 운행일이 이어지는 시간대라 24시를 더한다.
 */
export function nowMinutes(date: Date): number {
  const t = seoulTime(date);
  const raw = t.hour * 60 + t.minute;
  return t.hour < 4 ? raw + 24 * 60 : raw;
}

/** "24:53" 을 사람이 읽는 "00:53" 으로. */
export function displayTime(time: string): string {
  const minutes = toMinutes(time);
  if (minutes === null) return time;
  const wrapped = minutes % (24 * 60);
  const h = String(Math.floor(wrapped / 60)).padStart(2, "0");
  const m = String(wrapped % 60).padStart(2, "0");
  return `${h}:${m}`;
}

export type LineWindow = { first: number; last: number };

/** 시간표가 없는 노선에 쓰는 운행 시간대. 05:30 ~ 다음날 00:30. */
const DEFAULT_WINDOW: LineWindow = { first: 5 * 60 + 30, last: 24 * 60 + 30 };

export class Timetable {
  private readonly stations: Record<string, StationTable>;
  /** 노선·요일별 운행 시간대. 그 노선 모든 역의 첫차·막차를 아우른다. */
  private readonly windows = new Map<string, LineWindow>();

  constructor(file: TimetableFile) {
    this.stations = file.stations;

    for (const table of Object.values(file.stations)) {
      for (const [line, byDay] of Object.entries(table)) {
        for (const [day, byDir] of Object.entries(byDay)) {
          for (const edge of Object.values(byDir)) {
            if (!edge) continue;
            const first = toMinutes(edge[0]);
            const last = toMinutes(edge[2]);
            if (first === null || last === null) continue;

            const key = `${line}|${day}`;
            const prev = this.windows.get(key);
            if (!prev) this.windows.set(key, { first, last });
            else {
              if (first < prev.first) prev.first = first;
              if (last > prev.last) prev.last = last;
            }
          }
        }
      }
    }
  }

  /** 한 역의 노선별 첫차·막차. 시간표가 없는 역이면 빈 배열. */
  edgesFor(
    stationId: string,
    date: Date,
  ): Array<{ line: string; direction: Direction; edge: Edge }> {
    const table = this.stations[stationId];
    if (!table) return [];

    const day = dayTypeOf(date);
    const out: Array<{ line: string; direction: Direction; edge: Edge }> = [];
    for (const [line, byDay] of Object.entries(table)) {
      const byDir = byDay[day];
      if (!byDir) continue;
      for (const direction of ["up", "down"] as const) {
        const edge = byDir[direction];
        if (edge) out.push({ line, direction, edge });
      }
    }
    return out;
  }

  /** 노선의 운행 시간대. 시간표가 없는 노선이면 null. */
  windowFor(line: string, date: Date): LineWindow | null {
    return this.windows.get(`${line}|${dayTypeOf(date)}`) ?? null;
  }

  /**
   * 지금 그 노선이 운행 중인지.
   *
   * 시간표가 없는 노선(1~9호선 외)은 실제 첫차·막차를 알 수 없어서 국내
   * 도시철도에서 흔한 05:30~00:30 을 기본값으로 쓴다. 정확하지는 않지만
   * 새벽 3시에 열차가 돌아다니는 것보다는 실제에 가깝다.
   */
  isInService(line: string, date: Date): boolean {
    const w = this.windowFor(line, date) ?? DEFAULT_WINDOW;
    const now = nowMinutes(date);
    return now >= w.first && now <= w.last;
  }

  /** 시간표가 있는 노선인지. */
  has(line: string): boolean {
    return this.windows.has(`${line}|weekday`);
  }
}

/**
 * 시간표를 불러온다. 실패해도 앱은 시간표 없이 동작해야 하므로 null 을 돌려준다.
 */
export async function loadTimetable(): Promise<Timetable | null> {
  try {
    const res = await fetch("/data/timetable.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Timetable((await res.json()) as TimetableFile);
  } catch (error) {
    console.warn("timetable load failed", error);
    return null;
  }
}
