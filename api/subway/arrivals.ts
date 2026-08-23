import type { VercelRequest, VercelResponse } from "@vercel/node";

const UPSTREAM = "http://swopenapi.seoul.go.kr";
/** 환승역은 노선이 여러 개라 넉넉히 받는다. */
const ROW_LIMIT = 20;
/** 도착정보는 위치보다 빨리 변한다. 짧게 캐시한다. */
const CACHE_SECONDS = 10;
const STALE_SECONDS = 30;
/** 사용자가 팝업을 열어 두고 기다리는 요청이라 짧게 한 번만 시도한다. */
const UPSTREAM_TIMEOUT_MS = 6_000;
const ATTEMPTS = 1;

/**
 * 역명 허용 문자. 한글·영문·숫자와 역명에 실제로 쓰이는 기호만 통과시켜
 * 이 함수가 임의 경로를 대신 호출해 주는 통로가 되지 않게 한다.
 */
const STATION_PATTERN = /^[가-힣A-Za-z0-9·().\s-]{1,24}$/;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const key = process.env.SUBWAY;
  if (!key) {
    res.status(500).json({ code: "NO_KEY", message: "SUBWAY 환경변수가 설정되지 않았습니다." });
    return;
  }

  const raw = req.query.station;
  const station = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!station || !STATION_PATTERN.test(station)) {
    res.status(400).json({ code: "BAD_STATION", message: "역명이 올바르지 않습니다." });
    return;
  }

  const url = `${UPSTREAM}/api/subway/${key}/json/realtimeStationArrival/0/${ROW_LIMIT}/${encodeURIComponent(station)}`;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const upstream = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      const body = await upstream.text();

      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader(
        "Cache-Control",
        `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${STALE_SECONDS}, stale-if-error=${STALE_SECONDS}`,
      );
      res.status(upstream.ok ? 200 : 502).send(body);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  const timedOut = lastError instanceof DOMException && lastError.name === "TimeoutError";
  res.status(504).json({
    code: timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR",
    message: "도착정보 응답이 지연됩니다.",
  });
}
