import maplibregl from "maplibre-gl";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { pointAlong } from "../geo";
import { congestionColor } from "../sim/congestion";
import { headsign, type PreparedRoute, type Train } from "../sim/fleet";
import {
  beamTexture,
  CarKit,
  HIGH_SPEED_STYLE,
  instanced,
  loadTrainModel,
  type KitStyle,
  type TrainModel,
} from "./trainModel";

const ORIGIN: [number, number] = [126.9784, 37.5665];
/** 실제 전동차 1량 길이(m). */
const CAR_LENGTH_M = 20;
/**
 * 차체 폭·높이를 한 칸 길이에 대한 비율로.
 * 실제 비율(20m × 3.2m)대로 그리면 위에서 볼 때 실처럼 보여 열차로 읽히지
 * 않는다. 지도용으로 통통하게 잡는다.
 */
const CAR_WIDTH = 0.42;
const CAR_HEIGHT = 0.32;
/** 칸 사이를 살짝 띄워 편성이 마디로 보이게 한다. 둥근 끝이 연결부처럼 보인다. */
const CAR_FILL = 0.93;
/** 차체 모서리 둥글기(단위 상자 기준). 길이 방향으로는 끝이 둥글게 말린다. */
const BODY_RADIUS = 0.14;
/** 지붕은 노선 색에 흰색을 이만큼 섞는다. 위에서 볼 때 윗면이 밝게 떠야 입체로 읽힌다. */
const ROOF_TINT = 0.45;
const HEADLIGHT_COLOR = 0xfff4d6;
const TAILLIGHT_COLOR = 0xff3b30;
/** 맨 뒤 칸은 운전실차를 반대로 돌려 놓는다. */
const FLIP = new THREE.Matrix4().makeRotationY(Math.PI);
/**
 * 전조등이 선로에 깔리는 빛. 칸 단위 공간에서 앞쪽으로 한 칸 반쯤 뻗는다.
 * 밤에만 켠다.
 */
const BEAM_LOCAL = new THREE.Matrix4()
  .makeTranslation(1.25, 0, 0)
  .multiply(new THREE.Matrix4().makeScale(1.7, 1, 1.8));
const BEAM_OPACITY = 0.5;
/** 화면 밖 열차는 칸을 만들지 않는다. 경계에서 튀지 않게 이만큼(도) 여유를 둔다. */
const CULL_MARGIN_DEG = 0.012;
/** 아무리 멀어져도 편성 전체가 이 픽셀 길이보다 짧아 보이지 않게 한다. */
const MIN_TRAIN_PX = 15;
/** 차체 폭도 같은 이유로 하한을 둔다. 없으면 멀리서 실처럼 얇아진다. */
const MIN_WIDTH_PX = 5;
/** 이 줌부터 칸을 나눠 그린다. 그 아래는 한 덩어리라 어차피 구분되지 않는다. */
const CONSIST_ZOOM = 13.2;
/**
 * 전국을 볼 만큼 멀어지면 지하철 열차는 그리지 않는다. 수백 대가 수도권 한 점에
 * 뭉쳐 덩어리로만 보이고 고속열차를 가린다.
 */
const METRO_MIN_ZOOM = 8.6;
/** 한 편성의 최대 칸 수. */
const MAX_CARS = 10;
/** 인스턴스 상한. 열차 400대 × 10칸을 담고도 남는다. */
const MAX_INSTANCES = 4600;
/** 운전실차는 편성마다 앞뒤 두 량뿐이다. */
const MAX_CABS = 1000;
/** 고속열차는 편성이 길어 칸이 많고, 선두차는 편성마다 앞뒤 두 량이다. */
const MAX_HS_INSTANCES = 1500;
const MAX_HS_CABS = 300;
/** 혼잡도를 어림할 자료가 없는 열차. 사람 보기 모드에서만 쓴다. */
const UNKNOWN_CONGESTION_COLOR = "#6b6862";
const LAYER_ID = "metro-trains-3d";
const LABEL_SOURCE = "metro-train-labels";
const LABEL_LAYER = "metro-train-label";
export const TRAIN_HIT_LAYER = "metro-train-hit";
/** 이 줌 아래에서는 라벨이 서로 겹쳐 읽기 어렵다. */
const LABEL_MIN_ZOOM = 12.8;
/**
 * 라벨 갱신 주기(ms). setData 는 GeoJSON 을 워커로 넘겨 다시 파싱하므로
 * 매 프레임 호출하면 열차 수백 대에서 프레임이 무너진다.
 */
const LABEL_INTERVAL_MS = 400;

/** 그 줌에서 화면 1픽셀이 몇 미터인지. */
function metersPerPixel(zoom: number): number {
  return (156543.03392 * Math.cos((37.5665 * Math.PI) / 180)) / 2 ** zoom;
}

/** 한 차종 묶음: 중간차·운전실차와 앞뒤 등. 전동차와 고속열차가 각자 하나씩 갖는다. */
interface Rig {
  mid: CarKit;
  cab: CarKit;
  /** 등은 조명을 받지 않는 재질이라 밤에도 빛나 보인다. */
  head: THREE.InstancedMesh;
  tail: THREE.InstancedMesh;
  nHead: number;
  nTail: number;
}

function glow(color: number): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color });
  m.toneMapped = false;
  return m;
}

function makeRig(
  mid: TrainModel["mid"],
  cab: TrainModel["cab"],
  lamp: THREE.BufferGeometry,
  midCapacity: number,
  cabCapacity: number,
  style: KitStyle,
): Rig {
  return {
    mid: new CarKit(mid, midCapacity, style),
    cab: new CarKit(cab, cabCapacity, style),
    head: instanced(lamp, glow(HEADLIGHT_COLOR), cabCapacity),
    tail: instanced(lamp, glow(TAILLIGHT_COLOR), cabCapacity),
    nHead: 0,
    nTail: 0,
  };
}

function addRig(scene: THREE.Scene, rig: Rig): void {
  rig.mid.addTo(scene);
  rig.cab.addTo(scene);
  scene.add(rig.head, rig.tail);
}

function disposeMesh(mesh: THREE.InstancedMesh): void {
  const material = mesh.material as THREE.MeshBasicMaterial;
  material.map?.dispose();
  material.dispose();
  mesh.geometry.dispose();
  mesh.dispose();
}

function disposeRig(rig: Rig | null): void {
  if (!rig) return;
  rig.mid.dispose();
  rig.cab.dispose();
  disposeMesh(rig.head);
  disposeMesh(rig.tail);
}

/**
 * MapLibre 커스텀 3D 레이어. 맵의 GL 컨텍스트와 투영 행렬을 그대로 사용해서
 * 열차 박스를 노선 위에 정확히 올린다.
 */
class TrainLayer implements CustomLayerInterface {
  readonly id = LAYER_ID;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private map: MapLibreMap | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private camera = new THREE.Camera();
  private scene = new THREE.Scene();
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private trains: Train[] = [];
  private routes = new Map<string, PreparedRoute>();
  private originMerc = maplibregl.MercatorCoordinate.fromLngLat(ORIGIN, 0);
  /** 멀리서 편성을 한 덩어리로 그릴 때 쓰는 둥근 상자. */
  private boxes: THREE.InstancedMesh;
  /** 가까이서 쓰는 Blender 모델. 내려받기 전에는 비어 있다. */
  private metro: Rig | null = null;
  private highSpeed: Rig | null = null;
  /** 전조등 빛은 두 차종이 함께 쓴다. */
  private beams: THREE.InstancedMesh | null = null;
  private night: boolean;
  private white = new THREE.Color(0xffffff);
  private roofTint = new THREE.Color();
  private part = new THREE.Matrix4();
  private flipped = new THREE.Matrix4();
  private disposed = false;
  private rotX = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  private local = new THREE.Matrix4();
  private proj = new THREE.Matrix4();
  private scaleV = new THREE.Vector3();
  private bufW = 0;
  private bufH = 0;

  constructor(night: boolean) {
    this.night = night;
    // 단위 크기로 두고 칸마다 길이·폭·높이를 따로 준다. 바닥이 y=0 에 오게 올린다.
    const body = new RoundedBoxGeometry(1, 1, 1, 2, BODY_RADIUS);
    body.translate(0, 0.5, 0);
    // 조명을 받는 재질이라야 차체 윗면과 옆면의 밝기가 갈려 입체로 보인다.
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    mat.toneMapped = false;
    this.boxes = instanced(body, mat, MAX_INSTANCES);
    this.scene.add(this.boxes);

    // 위에서 살짝 비스듬히 비춰 윗면이 가장 밝고 옆면이 어둡게 한다.
    // 하늘빛을 높게 두어 노선 색이 어두워지지 않게 하고, 방향광은 면을
    // 구분할 만큼만 준다.
    const sun = new THREE.DirectionalLight(0xffffff, 0.7);
    sun.position.set(-0.45, 1, -0.35);
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb9bec8, 0.9));

    modelReady()
      .then((model) => this.useModel(model))
      .catch((error) => {
        // 모델이 없어도 둥근 상자로 계속 그린다.
        console.error("train model failed", error);
      });
  }

  private useModel(model: TrainModel): void {
    if (this.disposed) return;
    this.metro = makeRig(model.mid, model.cab, model.lamp, MAX_INSTANCES, MAX_CABS, {});
    this.highSpeed = makeRig(
      model.hsMid,
      model.hsCab,
      model.hsLamp,
      MAX_HS_INSTANCES,
      MAX_HS_CABS,
      HIGH_SPEED_STYLE,
    );
    addRig(this.scene, this.metro);
    addRig(this.scene, this.highSpeed);

    const plane = new THREE.PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI / 2);
    const beam = new THREE.MeshBasicMaterial({
      color: HEADLIGHT_COLOR,
      map: beamTexture(),
      transparent: true,
      opacity: BEAM_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    beam.toneMapped = false;
    this.beams = instanced(plane, beam, MAX_CABS + MAX_HS_CABS);
    this.scene.add(this.beams);

    this.setNight(this.night);
    this.map?.triggerRepaint();
  }

  setNight(night: boolean): void {
    this.night = night;
    for (const rig of [this.metro, this.highSpeed]) {
      rig?.mid.setNight(night);
      rig?.cab.setNight(night);
    }
  }

  setTrains(trains: Train[]): void {
    this.trains = trains;
  }

  /** 칸을 선로 곡선 위에 올리려면 노선 형상이 필요하다. */
  setRoutes(routes: PreparedRoute[]): void {
    this.routes = new Map(routes.map((r) => [r.id, r]));
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: true,
    });
    this.renderer.autoClear = false;
  }

  onRemove(): void {
    this.disposed = true;
    this.scene.clear();
    this.boxes.geometry.dispose();
    (this.boxes.material as THREE.Material).dispose();
    this.boxes.dispose();
    disposeRig(this.metro);
    disposeRig(this.highSpeed);
    if (this.beams) disposeMesh(this.beams);
    this.renderer?.dispose();
    this.renderer = null;
    this.map = null;
  }

  render(_gl: unknown, args: CustomRenderMethodInput): void {
    const map = this.map;
    const renderer = this.renderer;
    if (!map || !renderer) return;

    this.syncViewport(renderer, map.getCanvas());
    this.sync(map);
    if (this.trains.length === 0) return;

    const t = this.originMerc;
    const meter = t.meterInMercatorCoordinateUnits();
    this.scaleV.set(meter, -meter, meter);
    this.local
      .identity()
      .makeTranslation(t.x, t.y, t.z)
      .scale(this.scaleV)
      .multiply(this.rotX);

    this.camera.projectionMatrix = this.proj
      .fromArray(args.defaultProjectionData.mainMatrix)
      .multiply(this.local);

    renderer.resetState();
    renderer.render(this.scene, this.camera);
    map.triggerRepaint();
  }

  /**
   * three는 생성 시점의 캔버스 크기로 뷰포트를 고정한다. 창 크기나 devicePixelRatio가
   * 바뀌면 GL 뷰포트가 옛 값에 묶여 화면 일부만 그려지므로 매 프레임 맞춰 준다.
   */
  private syncViewport(renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement): void {
    if (canvas.width === this.bufW && canvas.height === this.bufH) return;
    this.bufW = canvas.width;
    this.bufH = canvas.height;
    renderer.setPixelRatio(1);
    renderer.setViewport(0, 0, this.bufW, this.bufH);
  }

  private sync(map: MapLibreMap): void {
    const zoom = map.getZoom();
    const origin = this.originMerc;
    const meter = origin.meterInMercatorCoordinateUnits();
    const perPixel = metersPerPixel(zoom);
    const { metro, highSpeed, beams } = this;
    // 가까이서는 칸을 나눠 모델로 그리고, 멀어지면 한 덩어리로 둔다.
    const detailed = zoom >= CONSIST_ZOOM && !!metro && !!highSpeed && !!beams;
    const bounds = detailed ? map.getBounds() : null;
    let nBox = 0;
    let nBeam = 0;
    for (const rig of [metro, highSpeed]) {
      if (!rig) continue;
      rig.mid.begin();
      rig.cab.begin();
      rig.nHead = 0;
      rig.nTail = 0;
    }

    for (const train of this.trains) {
      if (nBox >= MAX_INSTANCES) break;
      if (bounds && !inView(bounds, train.coord)) continue;
      if (zoom < METRO_MIN_ZOOM && train.kind !== "express") continue;

      const cars = Math.max(1, Math.min(MAX_CARS, Math.round(train.cars) || 1));
      // 실제 편성 길이를 쓰되, 멀리서도 점처럼 사라지지 않게 하한을 둔다.
      const totalLength = Math.max(CAR_LENGTH_M * cars, MIN_TRAIN_PX * perPixel);
      const segments = detailed ? cars : 1;
      const segLength = totalLength / segments;
      // 폭은 칸 수와 무관하게 한 칸 길이를 기준으로 잡아야 편성이 길어져도
      // 굵어지지 않는다.
      const carLength = totalLength / cars;
      const width = Math.max(carLength * CAR_WIDTH, MIN_WIDTH_PX * perPixel);
      const height = width * (CAR_HEIGHT / CAR_WIDTH);

      // 혼잡도 값은 늘 들어 있지만, 색으로 쓸지는 화면 모드가 정한다.
      // 자료가 없어 값을 못 낸 열차를 노선 색으로 두면 혼잡도 색과 섞여
      // 읽히므로 회색으로 빼 둔다.
      // 고속열차는 혼잡도 자료가 없으니 늘 자기 노선 색을 쓴다.
      const express = train.kind === "express";
      const rig = express ? highSpeed : metro;
      const cabCapacity = express ? MAX_HS_CABS : MAX_CABS;
      this.color.set(
        !colorByCongestion || express
          ? train.color
          : train.congestion === undefined
            ? UNKNOWN_CONGESTION_COLOR
            : congestionColor(train.congestion),
      );
      this.roofTint.copy(this.color).lerp(this.white, ROOF_TINT);
      const route = this.routes.get(train.routeId);

      for (let c = 0; c < segments; c++) {
        // 편성 한가운데가 train.along 에 오도록 앞뒤로 벌린다.
        const offset = ((segments - 1) / 2 - c) * segLength;

        let coord = train.coord;
        let heading = train.heading;
        if (route && offset !== 0) {
          const pose = pointAlong(
            route.coords,
            route.dist,
            route.length,
            train.along + offset * train.dir,
          );
          coord = pose.coord;
          heading = train.dir === -1 ? (pose.heading + 180) % 360 : pose.heading;
        }

        const p = maplibregl.MercatorCoordinate.fromLngLat(coord, 0);
        this.dummy.position.set((p.x - origin.x) / meter, 0.8, (p.y - origin.y) / meter);
        this.dummy.rotation.set(0, ((90 - heading) * Math.PI) / 180, 0);
        this.dummy.scale.set(segLength * CAR_FILL, height, width);
        this.dummy.updateMatrix();
        const car = this.dummy.matrix;

        if (!detailed) {
          this.boxes.setMatrixAt(nBox, car);
          this.boxes.setColorAt(nBox, this.color);
          nBox++;
          continue;
        }

        // 맨 앞 칸은 진행 방향을 보는 운전실차, 맨 뒤 칸은 돌려 놓은 운전실차.
        // 앞에는 전조등, 뒤에는 미등을 켠다.
        const first = c === 0;
        const last = c === segments - 1;
        if (!rig || !beams) continue;
        if (last && rig.nTail < cabCapacity) {
          this.flipped.multiplyMatrices(car, FLIP);
          rig.tail.setMatrixAt(rig.nTail++, this.flipped);
        }
        if (first) {
          rig.cab.place(car, this.color, this.roofTint);
          if (rig.nHead < cabCapacity) {
            rig.head.setMatrixAt(rig.nHead++, car);
            beams.setMatrixAt(nBeam++, this.part.multiplyMatrices(car, BEAM_LOCAL));
          }
        } else if (last) {
          rig.cab.place(this.flipped, this.color, this.roofTint);
        } else {
          rig.mid.place(car, this.color, this.roofTint);
        }
      }
    }

    this.boxes.count = nBox;
    this.boxes.instanceMatrix.needsUpdate = true;
    if (this.boxes.instanceColor) this.boxes.instanceColor.needsUpdate = true;
    for (const rig of [metro, highSpeed]) {
      if (!rig) continue;
      rig.mid.commit();
      rig.cab.commit();
      rig.head.count = detailed ? rig.nHead : 0;
      rig.tail.count = detailed ? rig.nTail : 0;
      rig.head.instanceMatrix.needsUpdate = true;
      rig.tail.instanceMatrix.needsUpdate = true;
    }
    if (beams) {
      beams.count = detailed && this.night ? nBeam : 0;
      beams.instanceMatrix.needsUpdate = true;
    }
  }
}

function inView(bounds: maplibregl.LngLatBounds, coord: [number, number]): boolean {
  return (
    coord[0] >= bounds.getWest() - CULL_MARGIN_DEG &&
    coord[0] <= bounds.getEast() + CULL_MARGIN_DEG &&
    coord[1] >= bounds.getSouth() - CULL_MARGIN_DEG &&
    coord[1] <= bounds.getNorth() + CULL_MARGIN_DEG
  );
}

/** 모델은 한 번만 내려받는다. 지도 스타일이 바뀌면 레이어만 새로 만든다. */
let modelPromise: Promise<TrainModel> | null = null;
function modelReady(): Promise<TrainModel> {
  modelPromise ??= loadTrainModel();
  return modelPromise;
}

let layer: TrainLayer | null = null;

/** 열차 행선지를 GeoJSON 으로 만든다. 라벨이 보이는 줌에서만 호출한다. */
function labelData(trains: Train[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: trains.map((t) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: t.coord },
      properties: {
        id: t.id,
        label: headsign(t.destination),
        color: t.color,
      },
    })),
  };
}

function addLabelLayer(map: MapLibreMap): void {
  if (map.getLayer(LABEL_LAYER)) map.removeLayer(LABEL_LAYER);
  if (map.getSource(LABEL_SOURCE)) map.removeSource(LABEL_SOURCE);

  map.addSource(LABEL_SOURCE, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  // 열차를 클릭할 수 있게 하는 투명 원. 3D 박스는 커스텀 레이어라 직접 집을 수 없다.
  map.addLayer({
    id: TRAIN_HIT_LAYER,
    type: "circle",
    source: LABEL_SOURCE,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 6, 16, 14],
      "circle-color": "#000000",
      "circle-opacity": 0,
    },
  });

  map.addLayer({
    id: LABEL_LAYER,
    type: "symbol",
    source: LABEL_SOURCE,
    minzoom: LABEL_MIN_ZOOM,
    layout: {
      "text-field": ["get", "label"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 16, 12.5],
      // 열차 박스 위쪽에 띄운다.
      "text-offset": [0, -1.5],
      "text-anchor": "bottom",
      // 겹치면 MapLibre 가 알아서 일부만 남긴다.
      "text-optional": true,
      "text-padding": 3,
    },
    paint: {
      "text-color": ["get", "color"],
      "text-halo-color": "#fbf7ee",
      "text-halo-width": 1.6,
    },
  });
}

export function addTrainLayers(
  map: MapLibreMap,
  trains: Train[],
  routes: PreparedRoute[],
  night: boolean,
): void {
  for (const id of [LAYER_ID, TRAIN_HIT_LAYER, "metro-train-dot", "metro-train-glow", "metro-train-body"]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource("metro-trains")) map.removeSource("metro-trains");

  document.querySelector("#train-overlay")?.remove();

  layer = new TrainLayer(night);
  layer.setRoutes(routes);
  layer.setTrains(trains);
  map.addLayer(layer);
  addLabelLayer(map);
}

/** 열차를 노선 색 대신 혼잡도 색으로 칠할지. */
let colorByCongestion = false;

export function setTrainColorMode(map: MapLibreMap, byCongestion: boolean): void {
  colorByCongestion = byCongestion;
  map.triggerRepaint();
}

/** 레이어가 만들어진 뒤에 도착한 노선(고속열차 등)을 넘긴다. */
export function setTrainRoutes(routes: PreparedRoute[]): void {
  layer?.setRoutes(routes);
}

let lastLabelAt = 0;

export function updateTrains(map: MapLibreMap, trains: Train[]): void {
  if (!layer || !map.getLayer(LAYER_ID)) return;
  layer.setTrains(trains);
  syncLabels(map, trains);
  map.triggerRepaint();
}

function syncLabels(map: MapLibreMap, trains: Train[]): void {
  const source = map.getSource(LABEL_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (!source) return;

  // 줌이 낮아도 소스는 채워 둔다. 글자만 감출 뿐 클릭 판정은 살아 있어야 한다.
  const now = performance.now();
  if (now - lastLabelAt < LABEL_INTERVAL_MS) return;
  lastLabelAt = now;
  source.setData(labelData(trains));
}
