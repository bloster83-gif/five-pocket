# 5 Pocket Diary — Claude 작업 가이드

Expo(React Native) + Supabase 기반 **5분할 매수·매도 일지** 앱. 멀티유저(RLS).

## 절대 규칙 (한국 주식 관례)
- **매수·상승·이익 = 빨강(`colors.buy`), 매도·하락·손실 = 파랑(`colors.sell`)** — 미국식(초록=상승)으로 "고치지" 말 것.
- 금액 표기: 한국주식 `₩` 소수점 없음, 미국주식 `$` 소수점 2자리 → `formatPrice`/`formatMoney` (src/theme.ts). 모든 숫자는 천단위 콤마.
- 응답은 한국어로.

## 구조
- `app/(app)/(tabs)/` — 5탭: index(프로젝트)·pockets(포켓)·journal(매매일지)·goals(인생목표)·stats(통계). 모든 탭 헤더 중앙 "5 Pocket Diary".
- `app/(app)/project/[id]/` — 상세(포켓 5개 고정)·trade(체결입력)·chart(캔들+매매마커).
- `src/domain/pockets.ts` — 핵심 순수함수: 포켓 목표가, `computePnL`(포켓 순환 대응: 포지션 0이면 원가 리셋), `realizedEvents`(매도 1건별 실현손익).
- `src/domain/goals.ts` — 인생목표 CAGR. 실제달성액 = 이월 ± 입출금 + 배당금 + 실현손익 (매매일지 자동 연동, 수동입력 없음).
- `src/services/prices/` — 시세 추상화. 기본 Yahoo(키 불필요, 15분 지연, 웹은 CORS 막힘→실기기에서만 라이브). `EXPO_PUBLIC_USE_MOCK=1`로 목업. 한글 종목검색은 Naver(`src/services/symbols.ts`) — Yahoo는 한글 쿼리 400 에러.
- 웹(react-native-web)에서 `Alert.alert`는 아무것도 안 뜸 → `src/lib/alert.ts`의 `notify`/`confirmAction` 사용.

## DB (Supabase)
- 전체 스키마: `supabase/schema.sql`(신규 설치용). 기존 DB에는 `supabase/migrations/*.sql`을 날짜순 실행.
- 모든 테이블 RLS로 사용자별 격리. 스키마 변경 시 새 마이그레이션 파일 추가 + schema.sql 동기화 + 앱은 미실행 상태에서도 깨지지 않게 방어(누락 감지 시 안내).
- trades는 project_id/pocket_id nullable(매매일지 독립 체결). 포켓은 매도 후 "재시작" 가능(같은 행 재사용, status=waiting).

## 검증
- `npx tsc --noEmit` → 에러 0 유지.
- `CI=1 npx expo export --platform web` → 번들 성공 확인.
- Expo SDK 54 (react 19.1, RN 0.81). `.npmrc`에 legacy-peer-deps.

## 실행 (PC)
- `npx expo start --tunnel` (이 PC는 공인 IP라 LAN 불가). PowerShell 실행정책 문제 시 `npx.cmd`.
