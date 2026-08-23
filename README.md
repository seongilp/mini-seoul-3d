# Mini Seoul 3D

수도권 전철을 3D 지도 위에 올려놓고, 열차가 실제 노선을 따라 움직이는 걸 실시간으로 보는 웹 모형입니다.

![stack](https://img.shields.io/badge/MapLibre_GL-5.x-1f6feb) ![stack](https://img.shields.io/badge/TypeScript-5.8-3178c6) ![stack](https://img.shields.io/badge/Vite-7.x-646cff)

## 무엇을 하나

- **24개 노선 · 634개 역 · 32개 운행 경로**를 실제 좌표 기반으로 렌더링
- 각 노선의 배차 간격(headway)과 시간대별 운행 밀도를 반영해 열차를 생성하고, 노선 폴리라인을 따라 보간 이동
- 역 정차(dwell) · 방향 전환 · 순환선(2호선) 처리
- 낮/밤 스타일 전환, 지하 구간 강조, 노선별 표시 토글, 역 검색과 플라이투
- 재생 속도 1x / 5x / 15x, 저사양용 eco 모드

## 실행

```bash
npm install
npm run dev      # http://localhost:5173
```

빌드 / 미리보기:

```bash
npm run build    # tsc --noEmit + vite build
npm run preview
```

지도 타일은 [OpenFreeMap](https://openfreemap.org) 공개 타일을 사용하므로 API 키가 필요 없습니다.

## 구조

```
src/
  main.ts            앱 진입점 · 애니메이션 루프 · 이벤트 배선
  types.ts           Network / Station / Route / SimState 타입
  geo.ts             좌표 거리 · 누적 거리 · 경로 보간
  map/
    createMap.ts     MapLibre 인스턴스 · 낮밤 스타일 · 지하 모드
    layers.ts        노선/역 레이어
    trains.ts        열차 레이어 및 프레임 갱신
  sim/fleet.ts       경로 준비 · 열차 시딩 · 시뮬레이션 스텝
  ui/hud.ts          시계 · 검색 · 범례 · 툴바
scripts/
  build-network.mjs  원천 데이터 → public/data/network.json 변환
public/data/
  network.json       빌드된 네트워크 데이터 (커밋되어 있음)
```

## 데이터

`public/data/network.json`은 이미 저장소에 포함되어 있어 바로 실행됩니다.

데이터를 다시 만들려면 `raw/` 디렉터리(용량 문제로 gitignore 처리)에 원천 파일이 필요합니다.

```
raw/vertices.min.json     노선 정점 좌표
raw/edges.min.json        노선 구간
raw/capitalStations.json  수도권 역 정보
raw/seoul_stations.json   역 순서 정보
```

준비되면:

```bash
npm run data
```

스크립트는 노선 메타(색상·배차·편성 칸 수)를 `LINE_META`에 두고, 원천 데이터의 노선명 표기 차이를 `LINE_ALIASES`로 정규화합니다.

## 시뮬레이션 규칙

| 항목 | 값 |
|---|---|
| 순항 속도 | 15.5 m/s |
| 역 정차 | 14초 |
| 첨두(07–09, 18–20) | 밀도 1.15배 |
| 심야(01–05) | 밀도 0.08배 |

실제 운행 정보(열차 위치 API)를 쓰지 않는 절차적 모형입니다. 실시간 지연이나 실제 편성 위치와는 일치하지 않습니다.

## 라이선스

MIT
