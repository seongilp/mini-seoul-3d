import "./style.css";
import type { MapLayerMouseEvent } from "maplibre-gl";
import { createMap, restyleBase, setUnderground, STYLES } from "./map/createMap";
import { addTransitLayers } from "./map/layers";
import { addTrainLayers, updateTrains } from "./map/trains";
import { prepareRoutes, seedTrains, stepFleet, type Train } from "./sim/fleet";
import type { Network, SimState } from "./types";
import { mountHud } from "./ui/hud";

const state: SimState = {
  clockMs: Date.now(),
  speed: 5,
  eco: false,
  underground: false,
  night: false,
  hiddenLines: new Set(),
};

const speeds = [1, 5, 15];
let trains: Train[] = [];
let last = performance.now();

const hudRoot = document.querySelector("#hud") as HTMLElement;
const loader = document.querySelector("#loader") as HTMLElement;

const network = (await fetch("/data/network.json").then((r) => r.json())) as Network;
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
});

function hideLoader() {
  if (!loader.isConnected) return;
  loader.classList.add("is-gone");
  setTimeout(() => loader.remove(), 500);
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

function frame(now: number) {
  const dt = Math.min(80, now - last);
  last = now;
  state.clockMs += dt * state.speed;
  stepFleet(trains, routes, state, dt);
  if (map.isStyleLoaded()) {
    updateTrains(map, trains);
  }
  hud.tick(new Date(state.clockMs), trains.length);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
