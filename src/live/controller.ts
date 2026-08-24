import type { Train } from "../sim/fleet";
import { fetchPositions, LiveApiError, QuotaExceededError } from "./client";
import type { LiveLine } from "./lines";
import { placeLiveTrains, type PlaceStats, type RouteIndex } from "./place";

/**
 * 폴링 주기(ms). 상류 데이터가 실측 15~20초마다 갱신되므로 이보다 짧게 잡아도
 * 같은 값만 받는다.
 *
 * 한도가 풀렸다고 해서 아래 절약 장치(화면에 걸치는 노선만 호출, 탭이 가려지면
 * 정지, 한도 오류 감지 시 중단)를 걷어내지는 않는다. 한도가 여전히 유한하다면
 * 앱이 죽는 대신 그 장치들이 받아 준다.
 */
const POLL_MS = 15_000;
/** 연속 실패 시 최대 대기(ms). */
const MAX_BACKOFF_MS = 5 * 60_000;

export type LiveStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "paused" }
  | {
      kind: "ok";
      trains: number;
      calls: number;
      failedLines: string[];
      stats: PlaceStats;
      at: Date;
    }
  | { kind: "quota"; message: string }
  | { kind: "error"; message: string; retryInSec: number };

export type LiveController = {
  start: () => void;
  stop: () => void;
  refresh: () => void;
  readonly running: boolean;
};

/** 이번 폴링에서 부를 노선을 고른다. 빈 배열이면 호출하지 않는다. */
export type LineSelector = () => LiveLine[];

export function createLiveController(
  index: RouteIndex,
  selectLines: LineSelector,
  onTrains: (trains: Train[]) => void,
  onStatus: (status: LiveStatus) => void,
): LiveController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;
  let running = false;
  let failures = 0;
  /** 한도를 소진하면 그날은 더 부르지 않는다. */
  let quotaExhausted = false;
  /** 노선별 마지막 성공 스냅샷. 부르지 않았거나 실패한 노선도 그대로 유지한다. */
  const lastByLine = new Map<string, Train[]>();

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (delay: number) => {
    clearTimer();
    if (!running || quotaExhausted) return;
    timer = setTimeout(poll, delay);
  };

  async function poll(): Promise<void> {
    if (!running || quotaExhausted) return;

    // 탭이 가려져 있으면 부르지 않는다. 보이지 않는 화면에 한도를 쓸 이유가 없다.
    if (document.hidden) {
      onStatus({ kind: "paused" });
      schedule(POLL_MS);
      return;
    }

    const lines = selectLines();
    if (lines.length === 0) {
      onStatus({ kind: "paused" });
      schedule(POLL_MS);
      return;
    }

    abort?.abort();
    abort = new AbortController();
    onStatus({ kind: "loading" });

    try {
      const result = await fetchPositions(lines, abort.signal);
      const { trains, stats } = placeLiveTrains(result.trains, index);

      const placedByLine = new Map<string, Train[]>();
      for (const t of trains) {
        const list = placedByLine.get(t.line);
        if (list) list.push(t);
        else placedByLine.set(t.line, [t]);
      }

      for (const r of result.results) {
        if (r.ok) lastByLine.set(r.line, placedByLine.get(r.line) ?? []);
      }

      const merged: Train[] = [];
      for (const list of lastByLine.values()) merged.push(...list);

      failures = 0;
      onTrains(merged);
      onStatus({
        kind: "ok",
        trains: merged.length,
        calls: result.calls,
        failedLines: result.results.filter((r) => !r.ok).map((r) => r.line),
        stats,
        at: new Date(),
      });
      schedule(POLL_MS);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;

      if (error instanceof QuotaExceededError) {
        // 더 부르면 한도만 축낸다. 그날은 여기서 멈춘다.
        quotaExhausted = true;
        clearTimer();
        onStatus({ kind: "quota", message: error.message });
        return;
      }

      failures += 1;
      const delay = Math.min(POLL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
      const message =
        error instanceof LiveApiError ? error.message : `실시간 데이터 처리 실패: ${String(error)}`;
      onStatus({ kind: "error", message, retryInSec: Math.round(delay / 1000) });
      schedule(delay);
    }
  }

  // 탭이 다시 보이면 곧바로 한 번 갱신한다.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && running && !quotaExhausted) {
      clearTimer();
      void poll();
    }
  });

  return {
    start() {
      if (running) return;
      if (quotaExhausted) {
        onStatus({ kind: "quota", message: "오늘 실시간 조회 한도를 모두 사용했습니다." });
        return;
      }
      running = true;
      failures = 0;
      void poll();
    },
    stop() {
      running = false;
      clearTimer();
      abort?.abort();
      abort = null;
      lastByLine.clear();
      onStatus({ kind: "idle" });
    },
    refresh() {
      if (running && !quotaExhausted) void poll();
    },
    get running() {
      return running;
    },
  };
}
