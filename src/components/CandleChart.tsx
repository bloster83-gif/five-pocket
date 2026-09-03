// 캔들 차트 (프로젝트 매매차트 · 관심종목 가치분석 공용)
//
// 두 화면이 완전히 같은 차트를 쓰도록 여기 한 곳에 모았다.
//   · 일/주/월봉 전환 · 핀치(짚은 곳 기준) 확대·축소 · ＋/－ 버튼
//   · 이동평균선 5·20·60·120 (네이버 증권 기본값)
//   · 처음엔 최근 1년치, 왼쪽으로 밀면 최대 10년치
//   · '가로 보기' — 기기를 돌리지 않고 화면 안에서 90° 회전
//   · 그리기: 선·가로선·세로선·화살표·사각형·원 + 꾹 눌러 선택 후 이동/모양 수정
//
// 프로젝트 차트만 쓰는 것(체결가 가격선·매매 마커)은 props 로 받는다.
// 상승=빨강(buy) / 하락=파랑(sell) — 한국 관례.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Circle, Ellipse, G, Line, Polygon, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { colors, formatPrice, num, radius, spacing } from '@/theme';
import { fetchCandles } from '@/services/prices/yahooProvider';
import { searchSymbols } from '@/services/symbols';
import type { SymbolResult } from '@/types/db';
import type { Candle, CandleMode } from '@/services/prices/yahooProvider';

const MODES: { key: CandleMode; label: string }[] = [
  { key: 'day', label: '일봉' },
  { key: 'week', label: '주봉' },
  { key: 'month', label: '월봉' },
];

// 이동평균선 — 네이버 증권 기본값(5·20·60·120)과 같은 기간.
// 색은 캔들의 빨강(상승)·파랑(하락)과 겹치지 않게 따로 골랐다.
const MA_LINES = [
  { n: 5, color: '#F59E0B' },
  { n: 20, color: '#A78BFA' },
  { n: 60, color: '#22D3A6' },
  { n: 120, color: '#94A3B8' },
] as const;

const PAD_TOP = 16;
const PAD_BOT = 24;
const AXIS_W = 56;
const MIN_CANDLE_W = 1.2;
const MAX_CANDLE_W = 28;
// 오른쪽 여백 — 마지막 봉이 화면 끝에 딱 붙어 날짜 라벨이 잘리지 않게 (가로 보기에서 특히)
const RIGHT_PAD = 46;
// 처음엔 3년치만 담아 두고, 왼쪽 끝까지 밀 때마다 5년 → 10년으로 넓힌다.
// (10년치를 한 번에 담으면 두 손가락으로 축소했을 때 너무 많은 봉이 쏟아진다)
const YEAR_STEPS = [3, 5, 10] as const;
/** 봉 종류별 1년치 봉 개수 (대략) */
const perYear = (m: CandleMode) => (m === 'day' ? 250 : m === 'week' ? 52 : 12);
const DETAIL_ZOOM = 6; // 캔들 폭이 이보다 넓으면 x축에 '일'까지 표기
const HIT_PX = 20; // 도형을 집었다고 보는 거리
const HANDLE_R = 6; // 조절점 반지름
// 매번 새 배열이 만들어져 계산이 되풀이되지 않도록 기본값은 한 번만 만든다
const NO_LINES: PriceLine[] = [];
const NO_MARKERS: TradeMarker[] = [];

function fmtDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

/** 차트를 가로질러 그리는 가격선 (체결가·목표가) */
export interface PriceLine {
  price: number;
  color: string;
  label: string;
}

/** 체결 시점 마커 (▲/▼ + 포켓번호) */
export interface TradeMarker {
  id: string;
  at: number; // 체결 시각 (ms)
  price: number;
  side: 'buy' | 'sell';
  label: string; // 예: 'P1'
}

// ─────────────────────────────────────────────────────────────
// 그리기 도형 — 화면 좌표가 아니라 '시간(t)·가격(p)'으로 저장한다.
// 그래야 확대·축소하거나 봉 종류를 바꿔도 원래 가리키던 자리에 붙어 있고,
// 같은 종목이면 프로젝트 차트와 가치분석 차트에서 똑같이 보인다.
// ─────────────────────────────────────────────────────────────
type Box = { t1: number; p1: number; t2: number; p2: number };
type Drawing =
  | ({ id: string; kind: 'line' } & Box)
  | ({ id: string; kind: 'arrow' } & Box)
  | ({ id: string; kind: 'rect' } & Box)
  | ({ id: string; kind: 'circle' } & Box)
  | { id: string; kind: 'hline'; p: number }
  | { id: string; kind: 'vline'; t: number };

type Tool = 'none' | 'line' | 'hline' | 'vline' | 'arrow' | 'rect' | 'circle' | 'erase';

const TOOLS: { key: Exclude<Tool, 'none' | 'erase'>; icon: string; label: string }[] = [
  { key: 'line', icon: '↗', label: '선' },
  { key: 'hline', icon: '↔', label: '가로선' },
  { key: 'vline', icon: '↕', label: '세로선' },
  { key: 'arrow', icon: '➤', label: '화살표' },
  { key: 'rect', icon: '□', label: '사각형' },
  { key: 'circle', icon: '○', label: '원' },
];
const DRAG_TOOLS: Tool[] = ['line', 'arrow', 'rect', 'circle'];
const TAP_TOOLS: Tool[] = ['hline', 'vline', 'erase'];
const DRAW = num.base; // 그린 도형 색 (보라 — 매수 빨강·매도 파랑과 구분)

// 봉 종류마다 따로 저장한다 — 일봉에 그은 추세선이 월봉에서 같은 자리일 리 없다.
const drawKey = (symbol: string, mode: CandleMode) => `chartDrawings:${symbol}:${mode}`;
const legacyKey = (symbol: string) => `chartDrawings:${symbol}`; // 봉 구분 전에 저장된 것 (일봉으로 본다)

async function loadDrawings(symbol: string, mode: CandleMode): Promise<Drawing[]> {
  try {
    let raw = await AsyncStorage.getItem(drawKey(symbol, mode));
    // 봉 구분이 없던 시절에 그린 것은 일봉으로 옮겨 온다 (한 번만)
    if (raw == null && mode === 'day') {
      raw = await AsyncStorage.getItem(legacyKey(symbol));
      if (raw != null) await AsyncStorage.setItem(drawKey(symbol, 'day'), raw);
    }
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    // 예전 이름('trend')으로 저장된 선, 지금은 뺀 자유선('free')을 정리한다
    return (arr as Record<string, unknown>[])
      .filter((d) => d?.kind !== 'free')
      .map((d) => (d.kind === 'trend' ? { ...d, kind: 'line' } : d)) as Drawing[];
  } catch {
    return [];
  }
}

async function saveDrawings(symbol: string, mode: CandleMode, list: Drawing[]) {
  try {
    await AsyncStorage.setItem(drawKey(symbol, mode), JSON.stringify(list));
  } catch {
    /* 저장 실패해도 화면은 그대로 */
  }
}

export function CandleChart({
  symbol: propSymbol,
  name: propName,
  market: propMarket,
  candles: propCandles,
  mode,
  onMode,
  loading: propLoading,
  error,
  lines = NO_LINES,
  markers = NO_MARKERS,
  height = 320,
}: {
  symbol: string;
  /** 종목명 — 가로 보기 왼쪽 위에 표시 */
  name?: string;
  market: string;
  candles: Candle[];
  mode: CandleMode;
  onMode: (m: CandleMode) => void;
  loading?: boolean;
  error?: string | null;
  lines?: PriceLine[];
  markers?: TradeMarker[];
  height?: number;
}) {
  const [candleW, setCandleW] = useState(9);

  // ── 가로 보기에서 다른 종목 둘러보기 ──────────────────────────
  // 검색해서 고른 종목의 봉을 이 자리에서 바로 불러와 보여준다.
  // 매매 마커·가격선은 원래 종목의 것이므로 둘러보는 동안에는 감춘다.
  const [browse, setBrowse] = useState<{ symbol: string; name: string; market: string } | null>(null);
  const [browseCandles, setBrowseCandles] = useState<Candle[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  useEffect(() => {
    if (!browse) return;
    let alive = true;
    setBrowseLoading(true);
    setBrowseCandles([]);
    fetchCandles(browse.symbol, mode)
      .then(({ candles: c }) => alive && setBrowseCandles(c))
      .catch(() => alive && setBrowseCandles([]))
      .finally(() => alive && setBrowseLoading(false));
    return () => {
      alive = false;
    };
  }, [browse?.symbol, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // 아래 계산은 전부 '지금 보고 있는 종목' 기준
  const symbol = browse?.symbol ?? propSymbol;
  const name = browse?.name ?? propName;
  const market = browse?.market ?? propMarket;
  const allCandles = browse ? browseCandles : propCandles;
  const loading = browse ? browseLoading : propLoading;
  const lines2 = browse ? NO_LINES : lines;
  const markers2 = browse ? NO_MARKERS : markers;

  // 지금 담아 둔 기간 (0=3년, 1=5년, 2=10년). 왼쪽 끝까지 밀면 한 칸씩 넓어진다.
  const [spanIdx, setSpanIdx] = useState(0);
  useEffect(() => {
    setSpanIdx(0); // 봉 종류·종목이 바뀌면 다시 3년치부터
  }, [mode, symbol]);
  const limitFor = useCallback(
    (i: number) => Math.min(allCandles.length, YEAR_STEPS[i] * perYear(mode)),
    [allCandles.length, mode]
  );
  const candles = useMemo(
    () => allCandles.slice(Math.max(0, allCandles.length - limitFor(spanIdx))),
    [allCandles, spanIdx, limitFor]
  );
  /** 더 넓힐 여지가 남았는지 (마지막 단계이거나 데이터가 그만큼 없으면 끝) */
  const hasMore = spanIdx < YEAR_STEPS.length - 1 && limitFor(spanIdx + 1) > limitFor(spanIdx);

  const { width: winW, height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isLandscape = winW > winH;
  const [wideView, setWideView] = useState(false);
  const chartH = wideView
    ? Math.max(200, winW - insets.left - insets.right - 150) // 회전 시에는 '기기 가로폭'이 차트 높이가 된다
    : isLandscape
      ? Math.max(200, winH - 170)
      : height;
  const plotH = chartH - PAD_TOP - PAD_BOT;

  // 이 화면에서는 회전 허용, 나가면 다시 세로 고정
  useEffect(() => {
    if (Platform.OS === 'web') return;
    ScreenOrientation.unlockAsync().catch(() => {});
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    };
  }, []);

  // ── 확대·축소 / 스크롤 ──────────────────────────────────────
  const candleWRef = useRef(candleW);
  candleWRef.current = candleW;
  const scrollRef = useRef<ScrollView>(null);
  const scrollXRef = useRef(0);
  const [scrollX, setScrollX] = useState(0);
  const plotWRef = useRef(0);
  const countRef = useRef(0);
  countRef.current = candles.length;
  const [plotW, setPlotW] = useState(0);

  /** 새 캔들 폭 기준으로 가로 스크롤 위치를 옮긴다 (양 끝을 넘지 않게 보정) */
  const scrollToX = useCallback((x: number, w: number) => {
    const maxX = Math.max(0, countRef.current * w + RIGHT_PAD - plotWRef.current);
    const nx = Math.min(maxX, Math.max(0, x));
    scrollXRef.current = nx;
    setScrollX(nx);
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ x: nx, animated: false }));
  }, []);

  /** 기준점(focal)을 화면에 고정한 채 캔들 폭을 w 로 바꾼다 */
  const zoomAround = useCallback(
    (w: number, focal: number) => {
      const w0 = candleWRef.current;
      if (w === w0) return;
      const idx = (scrollXRef.current + focal) / w0;
      setCandleW(w);
      scrollToX(idx * w - focal, w);
    },
    [scrollToX]
  );

  const pinchBase = useRef({ w: 9, focal: 0 });
  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onStart((e) => {
          pinchBase.current = { w: candleWRef.current, focal: Math.max(0, e.focalX - AXIS_W) };
        })
        .onUpdate((e) => {
          const w = Math.min(MAX_CANDLE_W, Math.max(MIN_CANDLE_W, Math.round(pinchBase.current.w * e.scale * 10) / 10));
          zoomAround(w, pinchBase.current.focal);
        }),
    [zoomAround]
  );

  /** 왼쪽 끝까지 밀었을 때 3년 → 5년 → 10년으로 넓힌다.
   *  늘어난 만큼 스크롤을 밀어 줘서, 보고 있던 자리는 그대로 있고 왼쪽만 이어진다. */
  const expandSpan = useCallback(() => {
    if (!hasMore) return;
    const cur = limitFor(spanIdx);
    const next = limitFor(spanIdx + 1);
    const added = next - cur;
    if (added <= 0) return;
    countRef.current = next; // scrollToX 의 최대치 계산이 새 길이를 알도록 먼저 갱신
    setSpanIdx(spanIdx + 1);
    scrollToX(scrollXRef.current + added * candleWRef.current, candleWRef.current);
  }, [hasMore, limitFor, spanIdx, scrollToX]);

  const zoomByButton = useCallback(
    (delta: number) => {
      const w = Math.min(MAX_CANDLE_W, Math.max(MIN_CANDLE_W, candleWRef.current + delta));
      zoomAround(w, plotWRef.current / 2);
    },
    [zoomAround]
  );

  // ── 좌표 계산 ───────────────────────────────────────────────
  // 화면에 보이는 봉 구간만 그린다 (10년치를 전부 그리면 SVG 요소가 수천 개가 되어 느려진다)
  const view = useMemo(() => {
    if (candles.length === 0 || plotW === 0) return { from: 0, to: candles.length };
    const pad = 30;
    const from = Math.max(0, Math.floor(scrollX / candleW) - pad);
    const to = Math.min(candles.length, Math.ceil((scrollX + plotW) / candleW) + pad);
    return { from, to };
  }, [candles.length, scrollX, candleW, plotW]);

  // 가격 축은 '보이는 구간' 기준 → 10년 전 가격 때문에 최근 움직임이 눌리지 않는다
  const { minP, maxP } = useMemo(() => {
    if (candles.length === 0) return { minP: 0, maxP: 1 };
    const shown = candles.slice(view.from, view.to);
    const src = shown.length > 0 ? shown : candles;
    let lo = Math.min(...src.map((c) => c.l));
    let hi = Math.max(...src.map((c) => c.h));
    markers2.forEach((t) => {
      lo = Math.min(lo, t.price);
      hi = Math.max(hi, t.price);
    });
    lines2.forEach((g) => {
      lo = Math.min(lo, g.price);
      hi = Math.max(hi, g.price);
    });
    const pad = (hi - lo) * 0.06 || 1;
    return { minP: lo - pad, maxP: hi + pad };
  }, [candles, markers2, lines2, view]);

  const priceToY = (p: number) => PAD_TOP + ((maxP - p) / (maxP - minP)) * plotH;
  const yToPrice = (y: number) => maxP - ((y - PAD_TOP) / plotH) * (maxP - minP);
  const chartW = Math.max(candles.length * candleW + RIGHT_PAD, 10);

  /** 캔들 인덱스(소수 가능) → x (봉 가운데) */
  const idxToX = (i: number) => i * candleW + candleW / 2;
  const xToIdx = (x: number) => x / candleW - 0.5;
  const clampIdx = (i: number) => Math.max(0, Math.min(candles.length - 1, i));

  /** 시간 ↔ x — 봉 간격으로 사이·바깥을 이어서 계산한다 */
  const timeAt = (x: number): number => {
    const n = candles.length;
    if (n === 0) return 0;
    if (n === 1) return candles[0].t;
    const f = xToIdx(x);
    const lo = Math.floor(f);
    if (lo < 0) return candles[0].t + f * (candles[1].t - candles[0].t);
    if (lo >= n - 1) return candles[n - 1].t + (f - (n - 1)) * (candles[n - 1].t - candles[n - 2].t);
    return candles[lo].t + (f - lo) * (candles[lo + 1].t - candles[lo].t);
  };
  const xOfTime = (t: number): number => {
    const n = candles.length;
    if (n === 0) return 0;
    if (n === 1) return idxToX(0);
    if (t <= candles[0].t) {
      const step = candles[1].t - candles[0].t || 1;
      return idxToX((t - candles[0].t) / step);
    }
    if (t >= candles[n - 1].t) {
      const step = candles[n - 1].t - candles[n - 2].t || 1;
      return idxToX(n - 1 + (t - candles[n - 1].t) / step);
    }
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const span = candles[hi].t - candles[lo].t || 1;
    return idxToX(lo + (t - candles[lo].t) / span);
  };

  // x축 눈금 — 축소: 월이 바뀌는 지점에 '연/월', 확대: '연/월/일'. 해가 바뀌면 세로 점선.
  const axis = useMemo(() => {
    const ticks: { i: number; label: string }[] = [];
    const years: { i: number; year: number }[] = [];
    if (candles.length === 0) return { ticks, years };
    const detailed = candleW >= DETAIL_ZOOM;
    const minGapPx = detailed ? 62 : 50;
    let lastX = -Infinity;
    for (let i = view.from; i < view.to; i++) {
      const d = new Date(candles[i].t);
      const prev = i > 0 ? new Date(candles[i - 1].t) : null;
      const newYear = !!prev && prev.getFullYear() !== d.getFullYear();
      const newMonth = !prev || newYear || prev.getMonth() !== d.getMonth();
      if (newYear) years.push({ i, year: d.getFullYear() });
      if (!detailed && !newMonth) continue;
      const x = idxToX(i);
      if (x - lastX < minGapPx) continue;
      lastX = x;
      const YY = String(d.getFullYear()).slice(2);
      ticks.push({ i, label: detailed ? `${YY}/${d.getMonth() + 1}/${d.getDate()}` : `${YY}/${d.getMonth() + 1}` });
    }
    return { ticks, years };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, candleW, view]);

  // 매매 → 그 시점이 속한 캔들 인덱스 (t 이하의 마지막 캔들)
  const markerIndex = (at: number): number => {
    let idx = -1;
    for (let i = 0; i < candles.length; i++) {
      if (candles[i].t <= at) idx = i;
      else break;
    }
    return idx;
  };

  // 좌우로 밀어도 항상 보이도록, 가격선과 라벨은 스크롤되지 않는 오버레이에 그린다
  const overlayLines = useMemo(() => {
    const rows = lines2
      .map((g) => ({ ...g, y: PAD_TOP + ((maxP - g.price) / (maxP - minP)) * plotH }))
      .sort((a, b) => a.y - b.y);
    let last = -Infinity;
    return rows.map((r) => {
      const labelY = Math.max(r.y - 4, last + 13);
      last = labelY;
      return { ...r, labelY };
    });
  }, [lines2, minP, maxP, plotH]);

  // 이동평균 (단순이동평균). 봉이 모자란 구간은 null → 그 지점부터 선이 시작된다.
  const [maOn, setMaOn] = useState<Record<number, boolean>>({ 5: true, 20: true, 60: true, 120: true });
  const maSeries = useMemo(() => {
    const closes = candles.map((c) => c.c);
    return MA_LINES.map(({ n, color }) => {
      const pts: (number | null)[] = [];
      let sum = 0;
      for (let i = 0; i < closes.length; i++) {
        sum += closes[i];
        if (i >= n) sum -= closes[i - n];
        pts.push(i >= n - 1 ? sum / n : null);
      }
      return { n, color, pts, has: closes.length >= n };
    });
  }, [candles]);

  // 처음 열면 가장 최근 봉(=현재가)이 보이도록 오른쪽 끝으로 맞춘다
  const didInitScroll = useRef(false);
  useEffect(() => {
    didInitScroll.current = false; // 봉 종류·가로보기 전환·데이터 재조회 시 다시 맞춤
  }, [mode, wideView, allCandles.length]);
  useEffect(() => {
    if (didInitScroll.current) return;
    if (candles.length === 0 || plotW === 0) return;
    didInitScroll.current = true;
    // 데이터는 10년치를 받아두고, 처음 화면에는 최근 1년치만 담는다 (나머지는 왼쪽으로 밀면 나온다)
    const oneYear = mode === 'day' ? 250 : mode === 'week' ? 52 : 12;
    const visible = Math.max(1, Math.min(oneYear, candles.length));
    const w = Math.min(MAX_CANDLE_W, Math.max(MIN_CANDLE_W, Math.round((plotW / visible) * 10) / 10));
    setCandleW(w);
    candleWRef.current = w;
    scrollToX(candles.length * w + RIGHT_PAD - plotW, w);
  }, [candles.length, plotW, mode, scrollToX]);

  const gridLines = useMemo(() => {
    const n = 4;
    return Array.from({ length: n + 1 }, (_, i) => minP + ((maxP - minP) * i) / n);
  }, [minP, maxP]);

  // ── 가로 보기 종목 검색 ─────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SymbolResult[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (!searchOpen || q.length < 1) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        setResults(await searchSymbols(q));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query, searchOpen]);

  // ── 그리기 ─────────────────────────────────────────────────
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tool, setTool] = useState<Tool>('none');
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // 꾹 누른 채 움직이면 그 자리 봉을 따라가는 크로스헤어 (index, null = 안 하는 중)
  const [trackIdx, setTrackIdx] = useState<number | null>(null);
  // 수정 중인 도형의 원본 + 무엇을 잡았는지
  const editRef = useRef<{ base: Drawing; grab: 'move' | 0 | 1; x0: number; y0: number } | null>(null);

  useEffect(() => {
    let alive = true;
    setSelectedId(null); // 봉을 바꾸면 그림도 바뀌므로 선택은 풀어 준다
    loadDrawings(symbol, mode).then((d) => alive && setDrawings(d));
    return () => {
      alive = false;
    };
  }, [symbol, mode]);

  const commit = useCallback(
    (next: Drawing[]) => {
      setDrawings(next);
      saveDrawings(symbol, mode, next);
    },
    [symbol, mode]
  );

  const selected = drawings.find((d) => d.id === selectedId) ?? null;

  /** 도형을 화면 좌표로 */
  const boxPx = (d: Box) => ({ ax: xOfTime(d.t1), ay: priceToY(d.p1), bx: xOfTime(d.t2), by: priceToY(d.p2) });

  /** 선택했을 때 잡을 수 있는 조절점 (화면 좌표) */
  const handlesOf = (d: Drawing): { x: number; y: number }[] => {
    if (d.kind === 'hline') return [{ x: scrollXRef.current + plotW / 2, y: priceToY(d.p) }];
    if (d.kind === 'vline') return [{ x: xOfTime(d.t), y: PAD_TOP + plotH / 2 }];
    const { ax, ay, bx, by } = boxPx(d);
    return [
      { x: ax, y: ay },
      { x: bx, y: by },
    ];
  };

  const distToSeg = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  const distTo = (d: Drawing, px: number, py: number): number => {
    if (d.kind === 'hline') return Math.abs(py - priceToY(d.p));
    if (d.kind === 'vline') return Math.abs(px - xOfTime(d.t));
    const { ax, ay, bx, by } = boxPx(d);
    if (d.kind === 'line' || d.kind === 'arrow') return distToSeg(px, py, ax, ay, bx, by);
    if (d.kind === 'rect') {
      return Math.min(
        distToSeg(px, py, ax, ay, bx, ay),
        distToSeg(px, py, bx, ay, bx, by),
        distToSeg(px, py, bx, by, ax, by),
        distToSeg(px, py, ax, by, ax, ay)
      );
    }
    const cx = (ax + bx) / 2;
    const cy = (ay + by) / 2;
    const rx = Math.abs(bx - ax) / 2 || 1;
    const ry = Math.abs(by - ay) / 2 || 1;
    const ang = Math.atan2((py - cy) / ry, (px - cx) / rx);
    return Math.hypot(px - (cx + rx * Math.cos(ang)), py - (cy + ry * Math.sin(ang)));
  };

  /** 그 자리에서 가장 가까운 도형 */
  const hitTest = (px: number, py: number): Drawing | null => {
    let best: Drawing | null = null;
    let bestD = HIT_PX;
    for (const d of drawings) {
      const dist = distTo(d, px, py);
      if (dist < bestD) {
        bestD = dist;
        best = d;
      }
    }
    return best;
  };

  /** 도형 하나를 새 값으로 바꾼 목록 */
  const replace = (list: Drawing[], next: Drawing) => list.map((d) => (d.id === next.id ? next : d));

  /** 이동/모양 수정 결과 계산 */
  const applyEdit = (base: Drawing, grab: 'move' | 0 | 1, dx: number, dy: number, x: number, y: number): Drawing => {
    if (base.kind === 'hline') {
      return { ...base, p: grab === 'move' ? yToPrice(priceToY(base.p) + dy) : yToPrice(y) };
    }
    if (base.kind === 'vline') {
      return { ...base, t: grab === 'move' ? timeAt(xOfTime(base.t) + dx) : timeAt(x) };
    }
    const { ax, ay, bx, by } = boxPx(base);
    if (grab === 'move') {
      return {
        ...base,
        t1: timeAt(ax + dx),
        p1: yToPrice(ay + dy),
        t2: timeAt(bx + dx),
        p2: yToPrice(by + dy),
      };
    }
    // 끝점 하나만 옮긴다 → 기울기·크기가 바뀐다
    return grab === 0
      ? { ...base, t1: timeAt(x), p1: yToPrice(y) }
      : { ...base, t2: timeAt(x), p2: yToPrice(y) };
  };

  // 꾹 누른 채 움직이면 날짜·종가를 따라간다 (네이버 증권 차트와 같은 동작).
  // 그냥 미는 건 가로 스크롤이어야 하므로, 길게 누른 뒤에만 시작한다.
  const track = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .enabled(tool === 'none' && !selected)
        .activateAfterLongPress(250)
        .onStart((e) => setTrackIdx(clampIdx(Math.round(xToIdx(e.x)))))
        .onUpdate((e) => setTrackIdx(clampIdx(Math.round(xToIdx(e.x)))))
        .onEnd(() => setTrackIdx(null))
        .onFinalize(() => setTrackIdx(null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool, selected, candleW, candles.length]
  );

  // 선택된 도형 옮기기 / 끝점 잡아 모양 바꾸기
  const editPan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .enabled(tool === 'none' && !!selected)
        .minDistance(2)
        .onStart((e) => {
          if (!selected) return;
          const hs = handlesOf(selected);
          let grab: 'move' | 0 | 1 | null = null;
          hs.forEach((h, i) => {
            if (grab === null && Math.hypot(e.x - h.x, e.y - h.y) < HANDLE_R * 3) grab = i as 0 | 1;
          });
          if (grab === null && distTo(selected, e.x, e.y) < HIT_PX) grab = 'move';
          editRef.current = grab === null ? null : { base: selected, grab, x0: e.x, y0: e.y };
        })
        .onUpdate((e) => {
          const ed = editRef.current;
          if (!ed) return;
          setDrawings((list) => replace(list, applyEdit(ed.base, ed.grab, e.x - ed.x0, e.y - ed.y0, e.x, e.y)));
        })
        .onEnd((e) => {
          const ed = editRef.current;
          if (!ed) return;
          const next = applyEdit(ed.base, ed.grab, e.x - ed.x0, e.y - ed.y0, e.x, e.y);
          setDrawings((list) => {
            const out = replace(list, next);
            saveDrawings(symbol, mode, out);
            return out;
          });
        })
        .onFinalize(() => {
          editRef.current = null;
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool, selected, drawings, candleW, minP, maxP, plotH, symbol, mode]
  );

  // 끌어서 그리는 도구
  const drawPan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .enabled(DRAG_TOOLS.includes(tool))
        .minDistance(2)
        .onStart((e) => setDragging({ x1: e.x, y1: e.y, x2: e.x, y2: e.y }))
        .onUpdate((e) => setDragging((p) => (p ? { ...p, x2: e.x, y2: e.y } : p)))
        .onEnd((e) => {
          setDragging((p) => {
            // 손가락을 거의 안 움직였으면 실수로 찍은 것 — 만들지 않는다
            if (p && Math.hypot(e.x - p.x1, e.y - p.y1) > 8) {
              const box: Box = { t1: timeAt(p.x1), p1: yToPrice(p.y1), t2: timeAt(e.x), p2: yToPrice(e.y) };
              commit([...drawings, { id: `${Date.now()}`, kind: tool as 'line' | 'arrow' | 'rect' | 'circle', ...box }]);
            }
            return null;
          });
        })
        .onFinalize(() => setDragging(null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool, drawings, candleW, minP, maxP, plotH, commit]
  );

  // 탭하는 도구 (가로선·세로선·지우개) + 빈 곳 탭하면 선택 해제
  const tap = useMemo(
    () =>
      Gesture.Tap()
        .runOnJS(true)
        .onEnd((e) => {
          const id = `${Date.now()}`;
          if (tool === 'hline') return commit([...drawings, { id, kind: 'hline', p: yToPrice(e.y) }]);
          if (tool === 'vline') return commit([...drawings, { id, kind: 'vline', t: timeAt(e.x) }]);
          if (tool === 'erase') {
            const hit = hitTest(e.x, e.y);
            if (hit) commit(drawings.filter((d) => d.id !== hit.id));
            return;
          }
          if (tool === 'none' && paletteOpen) setSelectedId(hitTest(e.x, e.y)?.id ?? null);
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool, paletteOpen, drawings, candleW, minP, maxP, plotH, commit]
  );

  const chartGestures = useMemo(
    () => Gesture.Simultaneous(pinch, Gesture.Exclusive(drawPan, editPan, track, tap)),
    [pinch, drawPan, editPan, track, tap]
  );

  // 그리기·수정·추적 중에는 가로 스크롤을 멈춘다 (같은 드래그를 둘이 다투지 않게)
  const scrollEnabled = tool === 'none' && !selected && trackIdx === null;

  // ── 도형 그리기 ────────────────────────────────────────────
  const arrowHead = (ax: number, ay: number, bx: number, by: number) => {
    const ang = Math.atan2(by - ay, bx - ax);
    const L = 9;
    const W = 0.42;
    return `${bx},${by} ${bx - L * Math.cos(ang - W)},${by - L * Math.sin(ang - W)} ${bx - L * Math.cos(ang + W)},${by - L * Math.sin(ang + W)}`;
  };

  const renderShape = (d: Drawing) => {
    const on = d.id === selectedId;
    const w = on ? 2.6 : 1.8;
    if (d.kind === 'hline') {
      const y = priceToY(d.p);
      const label = formatPrice(d.p, market);
      // 라벨은 보고 있는 화면 '오른쪽 끝'에 붙여 둔다.
      // 왼쪽은 체결가·목표가 라벨 자리라 겹쳐서 안 읽힌다. 차트를 밀어도 계속 보이도록
      // 고정 위치가 아니라 지금 보이는 구간을 기준으로 잡는다.
      const lw = label.length * 6.5 + 8;
      const right = Math.max(0, scrollX) + (plotW || lw + 12) - 6;
      return (
        <G key={d.id}>
          <Line x1={0} y1={y} x2={chartW} y2={y} stroke={DRAW} strokeWidth={w} />
          {/* 캔들 위에 겹쳐도 읽히도록 글자 뒤에 어두운 판을 깔아준다 */}
          <Rect x={right - lw} y={y - 15} width={lw} height={14} rx={3} fill={colors.bg} opacity={0.75} />
          <SvgText x={right - 4} y={y - 5} fontSize={10} fontWeight="bold" fill={DRAW} textAnchor="end">
            {label}
          </SvgText>
        </G>
      );
    }
    if (d.kind === 'vline') {
      return (
        <Line key={d.id} x1={xOfTime(d.t)} y1={PAD_TOP} x2={xOfTime(d.t)} y2={PAD_TOP + plotH} stroke={DRAW} strokeWidth={w} />
      );
    }
    const { ax, ay, bx, by } = boxPx(d);
    if (d.kind === 'rect') {
      return (
        <Rect
          key={d.id}
          x={Math.min(ax, bx)}
          y={Math.min(ay, by)}
          width={Math.abs(bx - ax)}
          height={Math.abs(by - ay)}
          stroke={DRAW}
          strokeWidth={w}
          fill="none"
        />
      );
    }
    if (d.kind === 'circle') {
      return (
        <Ellipse
          key={d.id}
          cx={(ax + bx) / 2}
          cy={(ay + by) / 2}
          rx={Math.abs(bx - ax) / 2}
          ry={Math.abs(by - ay) / 2}
          stroke={DRAW}
          strokeWidth={w}
          fill="none"
        />
      );
    }
    return (
      <G key={d.id}>
        <Line x1={ax} y1={ay} x2={bx} y2={by} stroke={DRAW} strokeWidth={w} />
        {d.kind === 'arrow' && <Polygon points={arrowHead(ax, ay, bx, by)} fill={DRAW} />}
      </G>
    );
  };

  const preview = () => {
    if (!dragging) return null;
    const { x1, y1, x2, y2 } = dragging;
    if (tool === 'rect')
      return (
        <Rect x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)} stroke={DRAW} strokeWidth={1.6} strokeDasharray="4 3" fill="none" />
      );
    if (tool === 'circle')
      return (
        <Ellipse cx={(x1 + x2) / 2} cy={(y1 + y2) / 2} rx={Math.abs(x2 - x1) / 2} ry={Math.abs(y2 - y1) / 2} stroke={DRAW} strokeWidth={1.6} strokeDasharray="4 3" fill="none" />
      );
    return (
      <>
        <Line x1={x1} y1={y1} x2={x2} y2={y2} stroke={DRAW} strokeWidth={1.8} strokeDasharray="4 3" />
        {tool === 'arrow' && <Polygon points={arrowHead(x1, y1, x2, y2)} fill={DRAW} />}
      </>
    );
  };

  // ── 화면 ───────────────────────────────────────────────────
  const controls = (
    <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
      {MODES.map((m) => (
        <Pressable
          key={m.key}
          onPress={() => onMode(m.key)}
          style={{
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 8,
            backgroundColor: mode === m.key ? colors.buy : colors.cardAlt,
          }}
        >
          <Text style={{ color: mode === m.key ? '#fff' : colors.textDim, fontWeight: '700', fontSize: 13 }}>{m.label}</Text>
        </Pressable>
      ))}
      <View style={{ flex: 1 }} />
      <Pressable onPress={() => zoomByButton(-2)} style={zoomBtn}>
        <Text style={{ color: colors.text, fontWeight: '900', fontSize: 16 }}>－</Text>
      </Pressable>
      <Pressable onPress={() => zoomByButton(2)} style={zoomBtn}>
        <Text style={{ color: colors.text, fontWeight: '900', fontSize: 16 }}>＋</Text>
      </Pressable>
      <Pressable onPress={() => setWideView((v) => !v)} style={{ ...zoomBtn, width: 44 }}>
        <Text style={{ color: wideView ? colors.buy : colors.text, fontWeight: '900', fontSize: 15 }}>
          {wideView ? '⤡' : '⤢'}
        </Text>
      </Pressable>
    </View>
  );

  const maRow = (
    <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <Text style={{ color: colors.textDim, fontSize: 11 }}>이평선</Text>
      {maSeries.map((m) => (
        <Pressable
          key={m.n}
          onPress={() => m.has && setMaOn((v) => ({ ...v, [m.n]: !v[m.n] }))}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: maOn[m.n] && m.has ? m.color : colors.border,
            backgroundColor: maOn[m.n] && m.has ? 'rgba(255,255,255,0.06)' : 'transparent',
            opacity: m.has ? 1 : 0.35,
          }}
        >
          <View style={{ width: 10, height: 2, backgroundColor: m.color }} />
          <Text style={{ color: maOn[m.n] && m.has ? m.color : colors.textDim, fontSize: 11, fontWeight: '800' }}>{m.n}</Text>
        </Pressable>
      ))}
      <View style={{ flex: 1 }} />
      <ToolBtn
        label={paletteOpen ? '그리기 닫기' : '그리기'}
        icon="✏"
        active={paletteOpen}
        color={DRAW}
        onPress={() => {
          const open = !paletteOpen;
          setPaletteOpen(open);
          if (!open) {
            setTool('none');
            setSelectedId(null);
          }
        }}
      />
    </View>
  );

  const drawRow = paletteOpen && (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
      {selected ? (
        <>
          <Text style={{ color: DRAW, fontSize: 11, fontWeight: '800' }}>
            선택됨 — 끌어서 옮기고, 끝점(●)을 잡으면 모양이 바뀌어요
          </Text>
          <View style={{ flex: 1 }} />
          <ToolBtn
            label="삭제"
            icon="⌫"
            active={false}
            color={colors.danger}
            onPress={() => {
              commit(drawings.filter((d) => d.id !== selected.id));
              setSelectedId(null);
            }}
          />
          <ToolBtn label="선택 해제" icon="✓" active={false} color={colors.textDim} onPress={() => setSelectedId(null)} />
        </>
      ) : (
        <>
          {TOOLS.map((t) => (
            <ToolBtn
              key={t.key}
              label={t.label}
              icon={t.icon}
              active={tool === t.key}
              color={DRAW}
              onPress={() => setTool((cur) => (cur === t.key ? 'none' : t.key))}
            />
          ))}
          <ToolBtn label="지우개" icon="⌫" active={tool === 'erase'} color={colors.warn} onPress={() => setTool((cur) => (cur === 'erase' ? 'none' : 'erase'))} />
          {drawings.length > 0 && (
            <>
              <ToolBtn label="되돌리기" icon="↶" active={false} color={colors.textDim} onPress={() => commit(drawings.slice(0, -1))} />
              <ToolBtn label="모두 지우기" icon="🗑" active={false} color={colors.textDim} onPress={() => commit([])} />
            </>
          )}
        </>
      )}
    </View>
  );

  const hint = selected
    ? '도형을 끌면 옮겨지고, 끝점(●)을 잡으면 기울기·크기가 바뀌어요'
    : tool === 'none'
      ? paletteOpen
        ? '그린 도형을 탭하면 선택돼요 · 꾹 누른 채 움직이면 날짜·종가 추적'
        : '꾹 누른 채 움직이면 날짜·종가 · 왼쪽 끝까지 밀면 더 과거'
      : tool === 'erase'
        ? '지울 도형을 탭하세요'
        : TAP_TOOLS.includes(tool)
          ? '차트를 탭하면 그어져요'
          : '차트 위를 끌어서 그려요';

  // 추적 중인 봉 — 전 봉 대비 등락률까지 같이 보여준다
  const tracked = trackIdx != null ? candles[trackIdx] : null;
  const trackedPct =
    tracked && trackIdx! > 0 && candles[trackIdx! - 1].c > 0
      ? Math.round((tracked.c / candles[trackIdx! - 1].c - 1) * 10000) / 100
      : null;

  // 정보줄 — 평소엔 안내, 꾹 누르는 중엔 날짜·종가 (높이 고정이라 화면이 흔들리지 않는다)
  const infoRow = (
    <View style={{ height: 18, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {tracked ? (
        <>
          <Text style={{ color: colors.text, fontSize: 12, fontWeight: '800' }}>{fmtDay(tracked.t)}</Text>
          <Text style={{ color: num.live, fontSize: 13, fontWeight: '900' }}>{formatPrice(tracked.c, market)}</Text>
          {trackedPct != null && (
            <Text style={{ color: trackedPct >= 0 ? colors.buy : colors.sell, fontSize: 12, fontWeight: '800' }}>
              {trackedPct > 0 ? '+' : ''}
              {trackedPct}%
            </Text>
          )}
          <View style={{ flex: 1 }} />
          <Text numberOfLines={1} style={{ color: colors.textDim, fontSize: 10 }}>
            시 {formatPrice(tracked.o, market)} · 고 {formatPrice(tracked.h, market)} · 저 {formatPrice(tracked.l, market)}
          </Text>
        </>
      ) : (
        <>
          <Text style={{ color: colors.textDim, fontSize: 10, fontWeight: '800' }}>
            {YEAR_STEPS[spanIdx]}년치{hasMore ? ` ↤ ${YEAR_STEPS[spanIdx + 1]}년` : ''}
          </Text>
          <Text numberOfLines={1} style={{ color: selected || tool !== 'none' ? DRAW : colors.textDim, fontSize: 10, flex: 1 }}>
            {hint}
          </Text>
        </>
      )}
    </View>
  );

  const chartBlock = (
    <>
      {maRow}
      {drawRow}
      {infoRow}

      {loading ? (
        <View style={{ height: chartH, justifyContent: 'center' }}>
          <ActivityIndicator color={colors.buy} />
        </View>
      ) : error ? (
        <View style={{ height: 120, justifyContent: 'center', gap: 4 }}>
          <Text style={{ color: colors.warn, textAlign: 'center' }}>{error}</Text>
          <Text style={{ color: colors.textDim, textAlign: 'center', fontSize: 12 }}>
            (웹에서는 CORS로 막힐 수 있어요. 폰에서 확인하세요.)
          </Text>
        </View>
      ) : (
        <View style={{ flexDirection: 'row' }}>
          <Svg width={AXIS_W} height={chartH}>
            {gridLines.map((p, i) => (
              <SvgText key={i} x={AXIS_W - 4} y={priceToY(p) + 3} fontSize={9} fill={colors.textDim} textAnchor="end">
                {formatPrice(p, market)}
              </SvgText>
            ))}
          </Svg>
          <View
            style={{ flex: 1 }}
            onLayout={(e) => {
              setPlotW(e.nativeEvent.layout.width);
              plotWRef.current = e.nativeEvent.layout.width;
            }}
          >
            <ScrollView
              ref={scrollRef}
              horizontal
              scrollEnabled={scrollEnabled}
              showsHorizontalScrollIndicator
              scrollEventThrottle={16}
              onScroll={(e) => {
                const x = e.nativeEvent.contentOffset.x;
                scrollXRef.current = x;
                setScrollX(x);
                if (x <= 4) expandSpan(); // 왼쪽 끝 → 더 오래된 기간을 이어 붙인다
              }}
            >
              <GestureDetector gesture={chartGestures}>
                <View style={{ width: chartW, height: chartH }}>
                  <Svg width={chartW} height={chartH}>
                    {gridLines.map((p, i) => (
                      <Line key={i} x1={0} y1={priceToY(p)} x2={chartW} y2={priceToY(p)} stroke={colors.border} strokeWidth={0.5} />
                    ))}
                    {/* 해가 바뀌는 지점 — 세로 점선 + 연도 */}
                    {axis.years.map((y) => {
                      const x = y.i * candleW;
                      return (
                        <G key={`y${y.i}`}>
                          <Line x1={x} y1={PAD_TOP} x2={x} y2={PAD_TOP + plotH} stroke={colors.textDim} strokeWidth={1} strokeDasharray="3 5" opacity={0.5} />
                          <SvgText x={x + 3} y={PAD_TOP + 9} fontSize={10} fontWeight="bold" fill={colors.textDim}>
                            {y.year}
                          </SvgText>
                        </G>
                      );
                    })}
                    {/* x축 날짜 라벨 + 세로 눈금 (하단) */}
                    {axis.ticks.map((t) => {
                      const x = idxToX(t.i);
                      return (
                        <G key={`d${t.i}`}>
                          <Line x1={x} y1={PAD_TOP + plotH} x2={x} y2={PAD_TOP + plotH + 4} stroke={colors.textDim} strokeWidth={0.5} />
                          <SvgText x={x} y={chartH - 8} fontSize={9} fill={colors.textDim} textAnchor="middle">
                            {t.label}
                          </SvgText>
                        </G>
                      );
                    })}
                    {candles.slice(view.from, view.to).map((c, j) => {
                      const i = view.from + j;
                      const x = idxToX(i);
                      const col = c.c >= c.o ? colors.buy : colors.sell;
                      const bodyTop = priceToY(Math.max(c.o, c.c));
                      const bodyH = Math.max(1, Math.abs(priceToY(c.o) - priceToY(c.c)));
                      const bodyW = Math.max(1, candleW * 0.7);
                      return <Rect key={`b${i}`} x={x - bodyW / 2} y={bodyTop} width={bodyW} height={bodyH} fill={col} />;
                    })}
                    {candles.slice(view.from, view.to).map((c, j) => {
                      const i = view.from + j;
                      const x = idxToX(i);
                      const col = c.c >= c.o ? colors.buy : colors.sell;
                      return <Line key={`w${i}`} x1={x} y1={priceToY(c.h)} x2={x} y2={priceToY(c.l)} stroke={col} strokeWidth={1} />;
                    })}

                    {/* 이동평균선 — 캔들 위에 겹쳐 그린다 */}
                    {maSeries.map((m) => {
                      if (!m.has || !maOn[m.n]) return null;
                      const pts = m.pts
                        .slice(view.from, view.to)
                        .map((v, j) => (v == null ? null : `${idxToX(view.from + j)},${priceToY(v)}`))
                        .filter(Boolean)
                        .join(' ');
                      if (!pts) return null;
                      return <Polyline key={`ma${m.n}`} points={pts} fill="none" stroke={m.color} strokeWidth={1.2} />;
                    })}

                    {/* 체결된 매수/매도 = 포인트(포켓번호 표시) */}
                    {markers2.map((t) => {
                      const di = markerIndex(t.at);
                      if (di < 0) return null;
                      const x = idxToX(di);
                      const y = priceToY(t.price);
                      const isBuy = t.side === 'buy';
                      const col = isBuy ? colors.buy : colors.sell;
                      const pts = isBuy
                        ? `${x},${y + 6} ${x - 4},${y + 14} ${x + 4},${y + 14}`
                        : `${x},${y - 6} ${x - 4},${y - 14} ${x + 4},${y - 14}`;
                      const labelY = isBuy ? y + 23 : y - 17;
                      return (
                        <G key={t.id}>
                          <Line x1={x} y1={y} x2={x} y2={isBuy ? y + 6 : y - 6} stroke={col} strokeWidth={1} />
                          <Polygon points={pts} fill={col} stroke="#fff" strokeWidth={0.8} />
                          <SvgText x={x} y={labelY} fontSize={9} fontWeight="bold" fill={col} textAnchor="middle">
                            {t.label}
                          </SvgText>
                        </G>
                      );
                    })}

                    {/* 내가 그린 도형 + 선택 시 조절점 */}
                    {drawings.map(renderShape)}
                    {selected &&
                      handlesOf(selected).map((h, i) => (
                        <Circle key={`h${i}`} cx={h.x} cy={h.y} r={HANDLE_R} fill={colors.bg} stroke={DRAW} strokeWidth={2.5} />
                      ))}
                    {preview()}

                    {/* 크로스헤어 — 꾹 누른 채 움직일 때 그 봉의 종가를 짚어준다 */}
                    {tracked && trackIdx != null && (
                      <G>
                        <Line
                          x1={idxToX(trackIdx)}
                          y1={PAD_TOP}
                          x2={idxToX(trackIdx)}
                          y2={PAD_TOP + plotH}
                          stroke={colors.text}
                          strokeWidth={1}
                          strokeDasharray="3 3"
                          opacity={0.7}
                        />
                        <Line
                          x1={Math.max(0, scrollX)}
                          y1={priceToY(tracked.c)}
                          x2={Math.max(0, scrollX) + plotW}
                          y2={priceToY(tracked.c)}
                          stroke={colors.text}
                          strokeWidth={1}
                          strokeDasharray="3 3"
                          opacity={0.7}
                        />
                        <Circle
                          cx={idxToX(trackIdx)}
                          cy={priceToY(tracked.c)}
                          r={4.5}
                          fill={tracked.c >= tracked.o ? colors.buy : colors.sell}
                          stroke="#fff"
                          strokeWidth={1.5}
                        />
                      </G>
                    )}
                  </Svg>
                </View>
              </GestureDetector>
            </ScrollView>

            {/* 가격선 + 라벨 오버레이 — 차트를 좌우로 밀어도 자리에 그대로 남는다 */}
            <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: plotW, height: chartH }}>
              <Svg width={plotW} height={chartH}>
                {overlayLines.map((g, i) => (
                  <G key={`o${i}`}>
                    <Line x1={0} y1={g.y} x2={plotW} y2={g.y} stroke={g.color} strokeWidth={1} strokeDasharray="5 4" opacity={0.9} />
                    {/* 캔들 위에 겹쳐도 읽히도록 글자 뒤에 어두운 판을 깔아준다 */}
                    <Rect x={3} y={g.labelY - 10} width={g.label.length * 7 + 8} height={13} rx={3} fill={colors.bg} opacity={0.72} />
                    <SvgText x={7} y={g.labelY} fontSize={10} fontWeight="bold" fill={g.color}>
                      {g.label}
                    </SvgText>
                  </G>
                ))}
              </Svg>
            </View>
          </View>
        </View>
      )}
    </>
  );

  // 가로 보기 — 화면 전체를 덮고 내용을 90° 돌려 크게 보여준다
  if (wideView) {
    return (
      <Modal visible transparent={false} animationType="fade" onRequestClose={() => setWideView(false)}>
        <StatusBar hidden />
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <View
            style={{
              position: 'absolute',
              top: (winH - winW) / 2,
              left: (winW - winH) / 2,
              width: winH,
              height: winW,
              transform: [{ rotate: '90deg' }],
              // 90° 돌린 좌표계라 기기의 상·하단(노치·홈 인디케이터)이 좌·우가 된다
              paddingLeft: insets.top + spacing.md,
              paddingRight: insets.bottom + spacing.lg,
              paddingTop: insets.right + spacing.sm,
              paddingBottom: insets.left + spacing.sm,
              gap: spacing.sm,
            }}
          >
            {/* 왼쪽 위: 지금 보고 있는 종목. 오른쪽: 다른 종목을 바로 찾아보기 */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <View style={{ flexShrink: 1 }}>
                <Text numberOfLines={1} style={{ color: colors.text, fontWeight: '900', fontSize: 16 }}>
                  {name || symbol}
                </Text>
                <Text numberOfLines={1} style={{ color: colors.textDim, fontSize: 11 }}>
                  {symbol} · {market === 'KRX' ? '🇰🇷 한국' : '🇺🇸 미국'}
                  {browse ? '  ·  둘러보는 중' : ''}
                </Text>
              </View>
              <View style={{ flex: 1 }} />
              {browse && (
                <Pressable
                  onPress={() => {
                    setBrowse(null);
                    setSearchOpen(false);
                  }}
                  style={{ ...zoomBtn, width: 'auto', paddingHorizontal: 10 }}
                >
                  <Text style={{ color: colors.textDim, fontWeight: '800', fontSize: 12 }}>↩ 원래 종목</Text>
                </Pressable>
              )}
              <Pressable
                onPress={() => {
                  setSearchOpen((v) => !v);
                  setQuery('');
                }}
                style={{ ...zoomBtn, width: 'auto', paddingHorizontal: 12 }}
              >
                <Text style={{ color: searchOpen ? colors.buy : colors.text, fontWeight: '900', fontSize: 13 }}>
                  🔍 종목 검색
                </Text>
              </Pressable>
            </View>

            {searchOpen && (
              <View style={{ gap: 6 }}>
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  autoFocus
                  placeholder="종목명 또는 티커 (예: 삼성전자, AAPL)"
                  placeholderTextColor={colors.textDim}
                  style={{
                    backgroundColor: colors.cardAlt,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: colors.border,
                    paddingHorizontal: spacing.md,
                    paddingVertical: 8,
                    color: colors.text,
                    fontSize: 15,
                  }}
                />
                {searching && <ActivityIndicator color={colors.primary} />}
                {results.length > 0 && (
                  <ScrollView style={{ maxHeight: 132 }} keyboardShouldPersistTaps="handled">
                    <View style={{ gap: 1, backgroundColor: colors.border, borderRadius: 8, overflow: 'hidden' }}>
                      {results.map((r) => (
                        <Pressable
                          key={`${r.market}:${r.symbol}`}
                          onPress={() => {
                            setBrowse({ symbol: r.symbol, name: r.name, market: r.market });
                            setSearchOpen(false);
                            setQuery('');
                            setSelectedId(null);
                          }}
                          style={{ backgroundColor: colors.cardAlt, paddingHorizontal: spacing.md, paddingVertical: 8 }}
                        >
                          <Text style={{ color: colors.text, fontWeight: '700' }}>{r.name}</Text>
                          <Text style={{ color: colors.textDim, fontSize: 11 }}>
                            {r.symbol} · {r.exchange} · {r.market === 'KRX' ? '한국' : '미국/기타'}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </ScrollView>
                )}
              </View>
            )}

            {controls}
            {chartBlock}
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <View style={{ gap: spacing.md }}>
      {controls}
      {chartBlock}
    </View>
  );
}

const zoomBtn = {
  width: 34,
  height: 30,
  borderRadius: 8,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  backgroundColor: colors.cardAlt,
  marginLeft: 4,
};

function ToolBtn({
  label,
  icon,
  active,
  color,
  onPress,
}: {
  label: string;
  icon: string;
  active: boolean;
  color: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: active ? color : colors.border,
        backgroundColor: active ? `${color}24` : colors.cardAlt,
      }}
    >
      <Text style={{ color: active ? color : colors.textDim, fontSize: 11, fontWeight: '900' }}>{icon}</Text>
      <Text style={{ color: active ? color : colors.textDim, fontSize: 11, fontWeight: '800' }}>{label}</Text>
    </Pressable>
  );
}
