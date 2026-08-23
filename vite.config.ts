import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig, loadEnv } from "vite";

const UPSTREAM = "http://swopenapi.seoul.go.kr";
const ENV_KEY = "SUBWAY";

/**
 * ~/.env 에서 한 개의 키만 꺼낸다. 이 파일에는 다른 비밀값도 들어 있으므로
 * 통째로 process.env 에 싣지 않는다.
 */
function readHomeEnv(name: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(homedir(), ".env"), "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0 || trimmed.slice(0, eq).trim() !== name) continue;
    return trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
  }
  return null;
}

export default defineConfig(({ mode }) => {
  // SUBWAY 는 VITE_ 접두사가 없으므로 클라이언트 번들에 들어가지 않는다.
  // 키는 dev 서버 프로세스에만 남고, 브라우저는 /api/subway 로만 요청한다.
  // 우선순위: 프로젝트 .env → ~/.env → sample(30행 제한 공개 키)
  const projectEnv = loadEnv(mode, process.cwd(), "");
  const key = projectEnv[ENV_KEY] || readHomeEnv(ENV_KEY) || "sample";

  if (key === "sample") {
    console.warn(`[subway] ${ENV_KEY} 키를 찾지 못해 sample 키로 동작합니다 (30행 제한).`);
  }

  return {
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        "/api/subway": {
          target: UPSTREAM,
          changeOrigin: true,
          // 프로덕션의 api/subway/*.ts 와 같은 인터페이스를 dev 에서 흉내낸다.
          rewrite: (path) => {
            const url = new URL(path, "http://x");
            if (url.pathname.endsWith("/arrivals")) {
              const station = url.searchParams.get("station") ?? "";
              return `/api/subway/${key}/json/realtimeStationArrival/0/20/${encodeURIComponent(station)}`;
            }
            const line = url.searchParams.get("line") ?? "";
            return `/api/subway/${key}/json/realtimePosition/0/300/${encodeURIComponent(line)}`;
          },
        },
      },
    },
  };
});
