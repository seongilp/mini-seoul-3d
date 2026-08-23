import type { Train } from "../sim/fleet";
import { fetchAllPositions, LiveApiError } from "./client";
import { placeLiveTrains, type PlaceStats, type RouteIndex } from "./place";

/**
 * 폴링 주기(ms). 노선당 1회 호출이므로 한 번 폴링에 LIVE_LINES.length(17)회를 쓴다.
 * 60초 주기면 하루 약 24,480회. 인증키 일일 한도에 맞춰 조정해야 한다.
 */
const POLL_MS = 60_000;
/** 연속 실패 시 최대 대기(ms). */
const MAX_BACKOFF_MS = 5 * 60_000;

export type LiveStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "ok";
      trains: number;
      calls: number;
      failedLines: string[];
      stats: PlaceStats;
      at: Date;
    }
  | { kind: "error"; message: string; retryInSec: number };

export type LiveController = {
  start: () => void;
  stop: () => void;
  refresh: () => void;
  readonly running: boolean;
};

export function createLiveController(
  index: RouteIndex,
  onTrains: (trains: Train[]) => void,
  onStatus: (status: LiveStatus) => void,
): LiveController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;
  let running = false;
  let failures = 0;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (delay: number) => {
    clearTimer();
    if (!running) return;
    timer = setTimeout(poll, delay);
  };

  async function poll(): Promise<void> {
    if (!running) return;
    abort?.abort();
    abort = new AbortController();
    onStatus({ kind: "loading" });

    try {
      const result = await fetchAllPositions(abort.signal);
      const { trains, stats } = placeLiveTrains(result.trains, index);
      failures = 0;
      onTrains(trains);
      onStatus({
        kind: "ok",
        trains: trains.length,
        calls: result.calls,
        failedLines: result.results.filter((r) => !r.ok).map((r) => r.line),
        stats,
        at: new Date(),
      });
      schedule(POLL_MS);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      failures += 1;
      const delay = Math.min(POLL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
      const message =
        error instanceof LiveApiError ? error.message : `실시간 데이터 처리 실패: ${String(error)}`;
      onStatus({ kind: "error", message, retryInSec: Math.round(delay / 1000) });
      schedule(delay);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      void poll();
    },
    stop() {
      running = false;
      clearTimer();
      abort?.abort();
      abort = null;
      onStatus({ kind: "idle" });
    },
    refresh() {
      if (running) void poll();
    },
    get running() {
      return running;
    },
  };
}
