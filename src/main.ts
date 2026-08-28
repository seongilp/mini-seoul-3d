import "./style.css";
import type { MapLayerMouseEvent } from "maplibre-gl";
import { createMap, restyleBase, setUnderground, STYLES } from "./map/createMap";
import { addTransitLayers } from "./map/layers";
import { CrowdLayer } from "./map/crowd";
import { addTrainLayers, updateTrains } from "./map/trains";
import { prepareRoutes, seedTrains, stepFleet, type Train } from "./sim/fleet";
import type { Network, SimState } from "./types";
import { loadRidership } from "./data/ridership";
import { loadTimetable, seoulTime, type Timetable } from "./data/timetable";
import { createLiveController, type LiveStatus } from "./live/controller";
import { LiveFleet } from "./live/interpolate";
import { LIVE_LINES, type LiveLine } from "./live/lines";
import { RouteIndex } from "./live/place";
import { mountHud } from "./ui/hud";

const state: SimState = {
  clockMs: Date.now(),
  speed: 5,
  eco: false,
  underground: false,
  night: false,
  live: false,
  crowd: false,
  hiddenLines: new Set(),
};

const speeds = [1, 5, 15];
let trains: Train[] = [];
let last = performance.now();

const hudRoot = document.querySelector("#hud") as HTMLElement;
const loader = document.querySelector("#loader") as HTMLElement;

let network: Network;
try {
  const res = await fetch("/data/network.json");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  network = (await res.json()) as Network;
} catch (error) {
  console.error("network load failed", error);
  showFatal("노선 데이터를 불러오지 못했습니다. 새로고침하거나 네트워크 연결을 확인해 주세요.");
  throw error;
}
const routes = prepareRoutes(network);
trains = seedTrains(routes, state);

const map = createMap(document.querySelector("#map") as HTMLElement, state.night);

const hud = mountHud(hudRoot, network, state, {
  onSearch(station) {
    hud.showStation(station);
    map.flyTo({
      center: [station.lng, station.lat],
      zoom: Math.max(map.getZoom(), 15.7),
      pitch: 64,
      essential: true,
    });
  },
  onToggleLine(id) {
    if (state.hiddenLines.has(id)) state.hiddenLines.delete(id);
    else state.hiddenLines.add(id);
    addTransitLayers(map, network, state.hiddenLines);
    trains = seedTrains(routes, state, timetable);
    hud.renderLegend();
  },
  onZoom(delta) {
    map.zoomTo(map.getZoom() + delta, { duration: 240 });
  },
  onCompass() {
    map.easeTo({ bearing: 0, pitch: 58, duration: 500 });
  },
  onFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  },
  onUnderground() {
    state.underground = !state.underground;
    setUnderground(map, state.underground, state.night);
  },
  onPlayback() {
    const i = speeds.indexOf(state.speed);
    state.speed = speeds[(i + 1) % speeds.length];
  },
  onEco() {
    state.eco = !state.eco;
    trains = seedTrains(routes, state, timetable);
  },
  onNight() {
    state.night = !state.night;
    map.setStyle(state.night ? STYLES.night : STYLES.day);
  },
  onLayers() {},
  onCrowd() {
    state.crowd = !state.crowd;
    crowd?.setVisible(map, state.crowd);
    if (state.crowd) crowd?.update(map, currentHour());
    hud.setCrowd(state.crowd);
  },
  onLive() {
    state.live = !state.live;
    if (state.live) {
      state.speed = 1; // 실시간에서는 배속이 의미가 없다.
      liveTrains.start();
    } else {
      liveTrains.stop();
      liveFleet.clear();
      trains = seedTrains(routes, state, timetable);
    }
  },
});

/** ?debug 를 붙이면 배치 실패·노선 지연 같은 진단 정보를 상태줄에 표시한다. */
const DEBUG = new URLSearchParams(location.search).has("debug");
if (DEBUG) {
  // 콘솔에서 지도와 시계를 들여다보고 조작할 수 있게 한다.
  Object.assign(window as unknown as Record<string, unknown>, {
    __map: map,
    /** 시뮬레이션 시계를 그날 특정 시각으로 옮긴다. 승하차 레이어 확인용. */
    __setHour(hour: number) {
      const d = new Date(state.clockMs);
      d.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
      state.clockMs = d.getTime();
    },
  });
}

function describeLive(status: LiveStatus): string {
  switch (status.kind) {
    case "idle":
      return "";
    case "loading":
      return "LIVE 불러오는 중";
    case "paused":
      return "LIVE 대기 중";
    case "quota":
      return "실시간 조회 한도 소진 · 내일 다시 사용할 수 있습니다";
    case "ok": {
      const time = `LIVE ${status.at.toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" })}`;
      if (!DEBUG) return time;
      const dropped = status.stats.unknownStation + status.stats.unknownDirection;
      const note = dropped > 0 ? ` · 미배치 ${dropped}` : "";
      const failed =
        status.failedLines.length > 0 ? ` · 지연 ${status.failedLines.join("/")}` : "";
      return `${time}${note}${failed}`;
    }
    case "error":
      return DEBUG ? `LIVE 오류 · ${status.retryInSec}초 후 재시도` : "LIVE 재연결 중";
  }
}

/**
 * 이번 폴링에서 부를 노선.
 *
 * 인증키 한도가 풀리기 전에는 화면에 걸치는 노선만 불렀는데, 그러면 지도를
 * 옮겼을 때 그 지역 열차가 낡은 위치로 보인다. 지금은 켜져 있는 노선을 모두
 * 부른다. 사용자가 범례에서 끈 노선은 화면에 그리지 않으므로 제외한다.
 */
function activeLines(): LiveLine[] {
  return LIVE_LINES.filter((meta) => !state.hiddenLines.has(meta.line));
}

const liveFleet = new LiveFleet(routes);

const liveTrains = createLiveController(
  new RouteIndex(routes, network.stations),
  activeLines,
  (next) => {
    liveFleet.update(next, performance.now());
  },
  (status) => {
    if (status.kind === "error") console.error("live:", status.message);
    if (status.kind === "quota") {
      // 더 켜 둬 봐야 부를 수 없다. 시뮬레이션으로 되돌린다.
      console.warn("live quota:", status.message);
      state.live = false;
      liveFleet.clear();
      trains = seedTrains(routes, state, timetable);
    }
    hud.setLive(state.live, describeLive(status));
  },
);

/**
 * MapLibre의 ResizeObserver가 놓치는 경로(전체화면 전환, 창 복원, 모바일 주소창 등)에서
 * 캔버스가 옛 크기에 묶여 화면 일부만 그려지는 것을 막는다.
 */
function syncMapSize() {
  map.resize();
}

window.addEventListener("resize", syncMapSize);
window.addEventListener("orientationchange", syncMapSize);
document.addEventListener("fullscreenchange", syncMapSize);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) syncMapSize();
});
window.visualViewport?.addEventListener("resize", syncMapSize);

function hideLoader() {
  if (!loader.isConnected) return;
  loader.classList.add("is-gone");
  setTimeout(() => loader.remove(), 500);
}

function showFatal(message: string) {
  loader.classList.remove("is-gone");
  loader.innerHTML = `<div class="loader-mark">MINI SEOUL 3D</div><div class="loader-sub"></div>`;
  loader.querySelector(".loader-sub")!.textContent = message;
}

function paintOverlay() {
  try {
    restyleBase(map, state.night);
    addTransitLayers(map, network, state.hiddenLines);
  } catch (error) {
    console.error("overlay failed", error);
    return;
  }
  try {
    addTrainLayers(map, trains);
    setUnderground(map, state.underground, state.night);
  } catch (error) {
    console.error("trains failed", error);
  }
  styleReady = true;
  try {
    attachCrowd();
  } catch (error) {
    console.error("crowd failed", error);
  }
}

/**
 * 승하차 기둥. 데이터가 늦게 와도, 스타일이 다시 로드돼도 붙일 수 있어야 한다.
 * style.load 핸들러 안에서는 map.isStyleLoaded() 가 아직 false 라서
 * 그 값 대신 paintOverlay 가 세우는 플래그를 본다.
 */
let crowd: CrowdLayer | null = null;
let styleReady = false;

function attachCrowd() {
  if (!crowd || !styleReady) return;
  // 열차 레이어보다 아래에 둬야 기둥이 열차를 가리지 않는다.
  crowd.attach(map, "metro-trains-3d");
  crowd.setVisible(map, state.crowd);
  crowd.update(map, currentHour());
}

/** 지금 화면이 나타내는 시각을 0~24 소수로. */
function currentHour(): number {
  const at = state.live ? new Date() : new Date(state.clockMs);
  const t = seoulTime(at);
  return t.hour + t.minute / 60;
}

void loadRidership().then((loaded) => {
  if (!loaded) return;
  crowd = new CrowdLayer(loaded, network.stations);
  hud.setRidership(loaded);
  attachCrowd();
});

/**
 * 시간표는 없어도 앱이 동작하므로 시작을 막지 않는다. 도착하면 HUD 에 넘기고
 * 시뮬레이션 운행 시간대 판정에 쓴다.
 */
let timetable: Timetable | null = null;
void loadTimetable().then((loaded) => {
  timetable = loaded;
  hud.setTimetable(loaded);
  if (!state.live) trains = seedTrains(routes, state, timetable);
});

map.on("style.load", paintOverlay);
if (map.isStyleLoaded()) paintOverlay();

map.on("load", hideLoader);
map.once("idle", hideLoader);
setTimeout(hideLoader, 2500);

map.on("click", "metro-station-ring", (e: MapLayerMouseEvent) => {
  const id = e.features?.[0]?.properties?.id as string | undefined;
  const station = network.stations.find((s) => s.id === id);
  if (station) {
    hud.showStation(station);
    map.easeTo({ center: [station.lng, station.lat], duration: 400 });
  }
});

map.on("click", (e) => {
  const hit = map.queryRenderedFeatures(e.point, { layers: ["metro-station-ring"] });
  if (!hit.length) hud.hideStation();
});

map.on("mouseenter", "metro-station-ring", () => {
  map.getCanvas().style.cursor = "pointer";
});
map.on("mouseleave", "metro-station-ring", () => {
  map.getCanvas().style.cursor = "";
});

/**
 * 운행 중인 노선 집합을 나타내는 문자열. 시뮬레이션 시계는 최대 15배속이라
 * 첫차·막차 경계를 수시로 넘는다. 이 값이 바뀌면 열차를 다시 배치한다.
 */
function serviceSignature(clockMs: number): string {
  if (!timetable) return "";
  const at = new Date(clockMs);
  return routes
    .map((r) => (timetable!.isInService(r.line, at) ? "1" : "0"))
    .join("");
}

let lastSignature = "";
let signatureCheckedAt = 0;
/** 경계 판정은 분 단위라 자주 볼 필요가 없다. */
const SIGNATURE_INTERVAL_MS = 1000;

/** 기둥 갱신 주기(ms). setData 는 워커 파싱이 있어 매 프레임 부를 수 없다. */
const CROWD_INTERVAL_MS = 250;
let crowdUpdatedAt = 0;

let frameNo = 0;
let pendingDt = 0;
function frame(now: number) {
  const dt = Math.min(80, now - last);
  last = now;
  state.clockMs += dt * state.speed;
  pendingDt += dt;
  const step = !state.eco || frameNo++ % 2 === 0;
  if (step) {
    if (state.live) {
      // 첫 응답 전에는 시뮬레이션 열차를 그대로 두어 화면이 비지 않게 한다.
      if (liveFleet.hasData()) trains = liveFleet.sample(now);
      else stepFleet(trains, routes, state, pendingDt);
    } else {
      if (timetable && now - signatureCheckedAt > SIGNATURE_INTERVAL_MS) {
        signatureCheckedAt = now;
        const signature = serviceSignature(state.clockMs);
        if (signature !== lastSignature) {
          lastSignature = signature;
          trains = seedTrains(routes, state, timetable);
        }
      }
      stepFleet(trains, routes, state, pendingDt);
    }
    pendingDt = 0;
    if (map.isStyleLoaded()) updateTrains(map, trains);
  }

  if (state.crowd && crowd && now - crowdUpdatedAt > CROWD_INTERVAL_MS) {
    crowdUpdatedAt = now;
    const hour = currentHour();
    crowd.update(map, hour);
    hud.updateCrowdNote(hour);
  }
  hud.tick(state.live ? new Date() : new Date(state.clockMs), trains.length);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
