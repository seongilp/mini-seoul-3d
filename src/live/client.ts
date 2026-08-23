import { LIVE_LINES, type LiveLine } from "./lines";

/** trainSttus: 열차의 statnNm 기준 상태. */
export const TRAIN_STATUS = {
  APPROACHING: "0", // 진입
  ARRIVED: "1", // 도착
  DEPARTED: "2", // 출발
  PREV_DEPARTED: "3", // 전역 출발
} as const;

export type LiveTrain = {
  trainNo: string;
  line: string;
  /** 열차가 기준으로 삼는 역. 접미("종착" 등)를 붙인 원본 그대로다. */
  stationName: string;
  /** 종착역. 다음 역이 아니다. 방향 판단의 보조 수단으로만 쓴다. */
  destination: string;
  /** 역 고유 번호. 노선 순서를 따라 단조증가하므로 방향 판단의 1차 근거다. */
  statnId: number;
  /** 종착역 번호. */
  terminalId: number;
  /** "0" = 상행/내선, "1" = 하행/외선. 순환선 방향 판정에 쓴다. */
  updown: string;
  status: string;
  /** 급행 여부. */
  express: boolean;
  isLastTrain: boolean;
  receivedAt: string;
};

type RawRow = Record<string, unknown>;

function str(row: RawRow, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v.trim() : "";
}

function normalizeRow(row: RawRow, meta: LiveLine): LiveTrain | null {
  const trainNo = str(row, "trainNo");
  const stationName = str(row, "statnNm");
  if (!trainNo || !stationName) return null;

  return {
    trainNo,
    line: meta.line,
    stationName,
    destination: str(row, "statnTnm"),
    statnId: Number.parseInt(str(row, "statnId"), 10) || 0,
    terminalId: Number.parseInt(str(row, "statnTid"), 10) || 0,
    updown: str(row, "updnLine"),
    status: str(row, "trainSttus"),
    express: str(row, "directAt") !== "0",
    isLastTrain: str(row, "lstcarAt") === "1",
    receivedAt: str(row, "recptnDt"),
  };
}

export class LiveApiError extends Error {}

export type LineResult =
  | { line: string; ok: true; trains: LiveTrain[] }
  | { line: string; ok: false; message: string };

type ApiEnvelope = {
  errorMessage?: { code?: string; message?: string; total?: number };
  realtimePositionList?: RawRow[];
  /** 권한 오류 등은 최상위에 code/message 가 온다. */
  code?: string;
  message?: string;
};

/**
 * 한 노선의 실시간 열차 위치를 가져온다.
 * INFO-200(데이터 없음)은 심야 시간대에 정상적으로 발생하므로 빈 배열로 처리한다.
 */
async function fetchLine(meta: LiveLine, signal?: AbortSignal): Promise<LineResult> {
  let res: Response;
  try {
    res = await fetch(`/api/subway/position?line=${encodeURIComponent(meta.apiName)}`, { signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { line: meta.line, ok: false, message: `연결 실패: ${String(error)}` };
  }
  if (!res.ok) return { line: meta.line, ok: false, message: `HTTP ${res.status}` };

  let body: ApiEnvelope;
  try {
    body = (await res.json()) as ApiEnvelope;
  } catch {
    return { line: meta.line, ok: false, message: "JSON 파싱 실패" };
  }

  const code = body.errorMessage?.code ?? body.code;
  if (code === "INFO-200") return { line: meta.line, ok: true, trains: [] };
  if (code && code !== "INFO-000") {
    return {
      line: meta.line,
      ok: false,
      message: `${code}: ${body.errorMessage?.message ?? body.message ?? ""}`,
    };
  }

  const rows = body.realtimePositionList;
  if (!Array.isArray(rows)) return { line: meta.line, ok: false, message: "응답 형식 불일치" };

  const trains: LiveTrain[] = [];
  for (const row of rows) {
    const parsed = normalizeRow(row, meta);
    if (parsed) trains.push(parsed);
  }
  return { line: meta.line, ok: true, trains };
}

export type FetchResult = {
  trains: LiveTrain[];
  /** 노선별 호출 결과. 일부만 실패해도 나머지는 그린다. */
  results: LineResult[];
  calls: number;
};

/**
 * 제공되는 모든 노선을 한 번에 가져온다.
 * 노선당 1회 호출이므로 호출 수 = LIVE_LINES.length.
 */
export async function fetchAllPositions(signal?: AbortSignal): Promise<FetchResult> {
  const settled = await Promise.all(LIVE_LINES.map((meta) => fetchLine(meta, signal)));

  const trains: LiveTrain[] = [];
  for (const r of settled) {
    if (r.ok) trains.push(...r.trains);
  }

  if (settled.every((r) => !r.ok)) {
    throw new LiveApiError(settled[0]?.message ?? "모든 노선 호출이 실패했습니다.");
  }

  return { trains, results: settled, calls: LIVE_LINES.length };
}
