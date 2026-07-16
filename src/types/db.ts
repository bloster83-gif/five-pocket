// Supabase 테이블과 1:1로 대응하는 타입 정의

export type Market = 'KRX' | 'US' | 'MOCK';
export type PocketStatus = 'waiting' | 'bought' | 'sold';
export type TradeSide = 'buy' | 'sell';
export type AlertKind = 'buy' | 'sell';

export interface Profile {
  id: string;
  display_name: string | null;
  expo_push_token: string | null;
  created_at: string;
}

export interface Project {
  id: string;
  user_id: string;
  symbol: string;
  name: string;
  market: Market;
  base_price: number;
  buy_interval_pct: number;
  sell_target_pct: number;
  pocket_count: number;
  total_budget: number | null;
  is_active: boolean;
  closed_at: string | null; // null = 진행중, 값 = 종료됨
  created_at: string;
}

export interface LifeGoal {
  user_id: string;
  current_age: number;
  target_age: number;
  start_asset: number;
  target_asset: number;
  base_year: number;
  updated_at: string;
}

export interface GoalActual {
  id: string;
  user_id: string;
  year: number;
  amount: number;
  deposit: number; // 연중 순 입출금
  created_at: string;
}

export interface Pocket {
  id: string;
  project_id: string;
  idx: number;
  buy_target_price: number;
  sell_target_price: number | null;
  weight: number;
  budget: number | null;
  status: PocketStatus;
  created_at: string;
}

export interface Trade {
  id: string;
  user_id: string;
  project_id: string | null; // 독립 체결이면 null
  pocket_id: string | null;
  symbol: string | null; // 독립 체결의 종목
  name: string | null;
  market: Market | null;
  side: TradeSide;
  price: number;
  quantity: number;
  executed_at: string;
  note: string | null;
  created_at: string;
}

export interface PriceAlert {
  id: string;
  user_id: string;
  project_id: string;
  pocket_id: string | null;
  kind: AlertKind;
  target_price: number;
  triggered_price: number;
  triggered_at: string;
  created_at: string;
}

// 프로젝트 생성 시 클라이언트가 계산해 넣는 포켓의 초기값
export interface PocketSeed {
  idx: number;
  buy_target_price: number;
  sell_target_price: number;
  weight: number;
  budget: number | null;
}

export type CashFlowType = 'deposit' | 'withdrawal' | 'dividend';

export interface CashFlow {
  id: string;
  user_id: string;
  type: CashFlowType;
  amount: number;
  market: Market;
  occurred_at: string;
  note: string | null;
  created_at: string;
}

// 종목 검색 결과
export interface SymbolResult {
  symbol: string; // 예: '005930.KS', 'AAPL'
  name: string;
  market: Market; // 'KRX' | 'US'
  exchange: string; // 표시용 거래소명
}
