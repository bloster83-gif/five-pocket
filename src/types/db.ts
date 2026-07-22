// Supabase 테이블과 1:1로 대응하는 타입 정의

export type Market = 'KRX' | 'US' | 'MOCK';
// waiting: 매수 대기 · buy_ordered: 매수 주문완료(체결 대기) · bought: 보유중
// sell_ordered: 매도 주문완료(체결 대기) · sold: 매도 완료
export type PocketStatus = 'waiting' | 'buy_ordered' | 'bought' | 'sell_ordered' | 'sold';
export type TradeSide = 'buy' | 'sell';
export type AlertKind = 'buy' | 'sell';

// 회원 등급: diary = 최초 가입(수동 매매), auto = 관리자 인증(자동 매매)
export type MemberTier = 'diary' | 'auto';

export interface Profile {
  id: string;
  display_name: string | null;
  full_name: string | null; // 실명 (회원가입 필수)
  email: string | null;
  phone: string | null; // 휴대폰 번호 (숫자만)
  phone_verified: boolean; // 휴대폰 SMS 인증 완료 여부
  expo_push_token: string | null;
  tier: MemberTier;
  tier_expires_at: string | null; // AUTO 등급 만료 시각 (null = 무기한)
  is_admin: boolean;
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
  auto_trade_enabled: boolean; // 자동매매 on/off (AUTO 등급 전용)
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
  note: string | null; // 시스템/입력 기록 (자동주문 판별에 사용 — 사용자가 직접 편집하지 않음)
  user_note?: string | null; // 사용자가 직접 남기는 메모
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

// 한국투자증권(KIS) 계좌 설정 (사용자당 1개)
export interface BrokerAccount {
  user_id: string;
  broker: string; // 'KIS'
  app_key: string;
  app_secret: string;
  account_no: string; // 종합계좌번호 앞 8자리
  account_product_code: string; // 뒤 2자리 (보통 '01')
  is_virtual: boolean; // true = 모의투자
  access_token: string | null;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export type AutoOrderStatus = 'sent' | 'failed';

// 자동 매수/매도 주문 이력
export interface AutoOrder {
  id: string;
  user_id: string;
  project_id: string | null;
  pocket_id: string | null;
  side: TradeSide;
  symbol: string;
  order_price: number;
  quantity: number;
  status: AutoOrderStatus;
  kis_order_no: string | null;
  error_message: string | null;
  created_at: string;
}

// 인생목표 연도별 목표금액 수기 수정
export interface GoalTargetOverride {
  user_id: string;
  year: number;
  amount: number;
  updated_at: string;
}

// 종목 검색 결과
export interface SymbolResult {
  symbol: string; // 예: '005930.KS', 'AAPL'
  name: string;
  market: Market; // 'KRX' | 'US'
  exchange: string; // 표시용 거래소명
}

// 관심종목 레이더 — 기준가 직접 입력, 현재가/기준가 = '기준가 대비 %'
export interface WatchlistItem {
  id: string;
  user_id: string;
  symbol: string;
  name: string;
  market: Market;
  base_price: number;
  created_at: string;
}

// 관심종목 메모 (날짜 자동 기록)
export interface WatchlistMemo {
  id: string;
  item_id: string;
  user_id: string;
  note: string;
  created_at: string;
}
