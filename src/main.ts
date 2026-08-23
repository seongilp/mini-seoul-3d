import "./style.css";
import type { MapLayerMouseEvent } from "maplibre-gl";
import { createMap, restyleBase, setUnderground, STYLES } from "./map/createMap";
import { addTransitLayers } from "./map/layers";
import { addTrainLayers, updateTrains } from "./map/trains";
import { prepareRoutes, seedTrains, stepFleet, type Train } from "./sim/fleet";
import type { Network, SimState } from "./types";
import { createLiveController, type LiveStatus } from "./live/controller";
import { LiveFleet } from "./live/interpolate";
import { RouteIndex } from "./live/place";
import { mountHud } from "./ui/hud";

const state: SimState = {
  clockMs: Date.now(),
  speed: 5,
  eco: false,
  underground: false,
  night: false,
  live: false,
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
    trains = seedTrains(routes, state);
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
    trains = seedTrains(routes, state);
  },
  onNight() {
    state.night = !state.night;
    map.setStyle(state.night ? STYLES.night : STYLES.day);
  },
  onLayers() {},
  onLive() {
    state.live = !state.live;
    if (state.live) {
      state.speed = 1; // 실시간에서는 배속이 의미가 없다.
      liveTrains.start();
    } else {
      liveTrains.stop();
      liveFleet.clear();
      trains = seedTrains(routes, state);
    }
  },
});

function describeLive(status: LiveStatus): string {
  switch (status.kind) {
    case "idle":
      return "";
    case "loading":
      return "LIVE 불러오는 중";
    case "ok": {
      const dropped = status.stats.unknownStation + status.stats.unknownDirection;
      const note = dropped > 0 ? ` · 미배치 ${dropped}` : "";
      const failed =
        status.failedLines.length > 0 ? ` · 지연 ${status.failedLines.join("/")}호선` : "";
      return `LIVE ${status.at.toLocaleTimeString("ko-KR")}${note}${failed}`;
    }
    case "error":
      return `LIVE 오류 · ${status.retryInSec}초 후 재시도`;
  }
}

const liveFleet = new LiveFleet(routes);

const liveTrains = createLiveController(
  new RouteIndex(routes, network.stations),
  (next) => {
    liveFleet.update(next, performance.now());
  },
  (status) => {
    if (status.kind === "error") console.error("live:", status.message);
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
}

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
      stepFleet(trains, routes, state, pendingDt);
    }
    pendingDt = 0;
    if (map.isStyleLoaded()) updateTrains(map, trains);
  }
  hud.tick(state.live ? new Date() : new Date(state.clockMs), trains.length);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
