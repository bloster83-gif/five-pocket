# 5 Pocket Diary — Claude 작업 가이드

Expo(React Native) + Supabase 기반 **5분할 매수·매도 일지** 앱. 멀티유저(RLS).

## 절대 규칙 (한국 주식 관례)
- **매수·상승·이익 = 빨강(`colors.buy`), 매도·하락·손실 = 파랑(`colors.sell`)** — 미국식(초록=상승)으로 "고치지" 말 것.
- 금액 표기: 한국주식 `₩` 소수점 없음, 미국주식 `$` 소수점 2자리 → `formatPrice`/`formatMoney` (src/theme.ts). 모든 숫자는 천단위 콤마.
- **숫자 색상 통일(`num` in src/theme.ts)**: 앱 전체에서 같은 의미의 숫자는 같은 색. 보유수량·평균매수가·매입총액=`num.position`(핑크), 기준가=`num.base`(보라), 평가총액(현재가×수량)/총자산=`num.evalTotal`(앰버), 평가·실현손익/등락=`signColor()`(+빨강/-파랑), 실시간 현재가=`num.live`(하양), 예산·예수금=`num.budget`(청록). 매수목표가는 빨강(buy)·매도목표가는 파랑(sell) 유지. 새 숫자 추가 시 이 토큰을 쓸 것.
- 응답은 한국어로.

## 구조
- `app/(app)/(tabs)/` — 탭: radar(관심종목 레이더·가장 왼쪽)·index(프로젝트)·pockets(포켓)·journal(매매일지)·goals(인생목표)·my(내정보). stats는 MY 안에 임베드(탭바 숨김). 모든 탭 헤더 중앙 로고+"Pocket Diary", 헤더 좌측 등급 배지, 우측 👑(관리자만).
- **관심종목 레이더**: `app/(app)/(tabs)/radar.tsx` — 기준가 직접 입력, "기준가 대비 %"(=현재가÷기준가)로 감시. 필터(한국/미국/기준가 이하 100%↓/이상 100%↑), 종목별 메모(날짜 자동), 왼쪽 스와이프 삭제, 우측하단 + 추가. **그룹**: watchlist_groups(마이그레이션 20260728a) — ＋그룹으로 생성, 칩 길게 눌러 이름변경/삭제(소속 종목은 미분류로), 종목 펼침에서 그룹 지정, 그룹 칩으로 필터. DB: watchlist_items(+group_id)·watchlist_memos(마이그레이션 20260722a, RLS). 테이블 없으면 안내 카드로 방어(그룹 테이블 없으면 그룹 UI만 숨김). 종목 탭 → 펼침에 "📊 자세히 보기(가치분석)" 버튼.
- **가치분석 화면**: `app/(app)/stock/[symbol].tsx` — 맨 위 실시간 현재가(priceProvider 구독) + **프로젝트 매매차트와 동일한 캔들차트**(`src/components/CandleChart.tsx`) + 지표 카드(시총·PER·PBR·PEG·EPS·ROE·부채비율) + 5년 매출/영업이익/순이익 막대그래프 + 5년 PER 라인. 재무 데이터: `src/services/fundamentals.ts` — **미국=FMP**(`EXPO_PUBLIC_FMP_KEY`), **한국=네이버 증권 API**(m.stock.naver.com, 키 불필요, FMP 무료가 한국 미지원이라 분기). 정적 차트: `src/components/MiniCharts.tsx`(react-native-svg 막대·라인).
- **캔들차트(공용)**: `src/components/CandleChart.tsx` — 프로젝트 매매차트(`app/(app)/project/[id]/chart.tsx`)와 가치분석 화면이 같이 쓴다. 일/주/월봉·이평선 5·20·60·120·핀치 확대(짚은 곳 기준)·처음 3년치(왼쪽 끝까지 밀면 5년→10년)·가로 보기(화면 안 90° 회전)·꾹 누른 채 움직이면 날짜·종가 크로스헤어 추적·그리기(선/가로선/세로선/화살표/사각형/원 + 꾹 눌러 선택해 이동·끝점으로 모양 수정, 종목·봉 종류별 AsyncStorage `chartDrawings:<symbol>:<mode>`). 체결가 가격선·매매 마커는 `lines`/`markers` props 로 프로젝트 차트에서만 넘긴다. 도형은 시간·가격으로 저장돼 확대·봉 전환에도 자리를 지킨다. 미국 키 없으면 안내 카드로 방어(앱 정상). 라우트는 `(app)/_layout.tsx`에 등록됨(뒤로가기).
- `app/(app)/project/[id]/` — 상세(포켓 5개 고정)·trade(체결입력)·chart(캔들+매매마커).
- `app/(app)/admin.tsx` — 관리자 회원 관리(등급 Diary↔AUTO 변경). `app/(app)/broker.tsx` — 한투(KIS) 계좌 설정.
- **회원 등급**: profiles.tier = 'diary'(기본, 무료) | 'auto'(자동매매). useAuth()의 tier/isAdmin 사용. AUTO는 기간제(tier_expires_at, 1개월/6개월/1년) — 만료 시 diary 자동 강등(마이그레이션 g의 pg_cron + 러너 + 앱 3중 검사). useAuth().tier는 만료 반영된 유효 등급을 반환. AUTO 부여 경로 2가지: **① 인앱결제(RevenueCat)** ② 관리자 수동(admin.tsx) — 둘 다 유지.
- **인앱결제(AUTO 구독)**: `app/(app)/upgrade.tsx`(페이월) + `src/lib/purchases.ts`(웹/기본 no-op)·`purchases.native.ts`(RevenueCat 실제 구현, Metro 플랫폼 확장자로 분기)·`purchases.types.ts`. entitlement 식별자 **`auto`**. 결제→`supabase/functions/revenuecat-webhook`(RC 웹훅, service_role로 profiles.tier 자동 갱신, 만료 시 강등). **등급 보호**: `profiles.tier`/`tier_expires_at`/`is_admin`은 트리거로 자가 변경 차단(마이그레이션 20260813c) — service_role·pg_cron·관리자만 변경 가능(본인 diary 강등은 허용). 웹훅이 실패해도 복구되도록 `supabase/functions/verify-entitlement`(RC REST API로 실제 구독 확인 후 service_role로 반영, 시크릿 `RC_SECRET_KEY`) + `src/services/entitlement.ts`를 결제·복원 직후와 앱 시작 시(entitlement 살아있는데 등급이 diary일 때) 호출. 앱은 Purchases.logIn(supabase user id)로 연결(auth.tsx). RC 키는 `EXPO_PUBLIC_RC_IOS_KEY`/`EXPO_PUBLIC_RC_ANDROID_KEY`(공개 키). 키 없으면 페이월 자동 비활성(앱 정상). Expo Go/웹 미지원(정식 빌드만). 스토어·대시보드 설정은 `docs/iap-setup.md` 참고. 계좌입금 방식은 스토어 규정 위반이라 제거됨.
- **자동매매**: `src/services/autoTrader.ts`(신호→KIS 지정가 주문→auto_orders/trades 기록→포켓 상태 갱신) + `src/services/broker/kis.ts`(토큰 캐시·국내주문 placeDomesticOrder·해외주문 placeOverseasOrder, 모의/실전). 국내주문(실전)은 `EXCG_ID_DVSN_CD='SOR'`(KRX+넥스트레이드 최선체결) 먼저 시도→NXT 미지원/거부 시 KRX 폴백(모의는 KRX). 러너도 동일. AUTO 등급 + project.auto_trade_enabled + 네이티브. **한국(KRX)·미국(US) 모두** 클라이언트 자동주문 지원(미국은 해외 거래소 자동탐색 NAS/NYS/AMS→NASD/NYSE/AMEX). 미국 주문은 정규장(정규 TR TTTT1002U/1006U) + **주간거래(블루오션, 실전만: TTTS6036U/6037U, `/trading/daytime-order`)** 자동 분기 — 정규장 아니고 KST 10:00~22:30이면 주간거래로 주문. Diary 등급은 기존 수동 흐름 유지. 24시간 서버 러너(auto-trade-runner)도 KRX·US(정규장+주간거래) 모두 지원.
- **24시간 무인 자동매매**: `supabase/functions/auto-trade-runner/`(Deno) — pg_cron(마이그레이션 f)이 평일 매 1분 호출. 장시간 가드(국내 09:00~15:30 KST / 미국 정규장 09:30~16:00 ET, Deno Intl로 판정) + 포켓·방향별 10분 중복주문 가드. 미국은 해외시세(HHDFS00000300, 거래소 자동탐색)·해외주문(TTTT1002U/1006U). 클라이언트 autoTrader와 로직 동일하게 유지할 것.
- **네이버 로그인**: `supabase/functions/naver-auth/`(Edge Function, Deno — tsconfig에서 제외됨) + `src/lib/oauth.ts`의 signInWithNaver/completeNaverWebLogin.
- **회원가입 휴대폰 인증**: 이메일 가입은 실명·이메일·비밀번호·휴대폰 필수 + SMS OTP(알리고). `supabase/functions/send-phone-otp`·`verify-phone-otp`(--no-verify-jwt) + `src/lib/phoneAuth.ts` + phone_otps 테이블. 알리고 시크릿 없으면 devMode로 코드 반환(테스트). 가입 트리거가 phone_verified 저장.
- **SNS 가입 후 번호 게이트**: 로그인했는데 phone_verified=false면 `app/(app)/verify-phone.tsx`로 강제 이동(RootNavigator 게이트). verify-phone-otp가 Authorization 토큰 있으면 그 사용자 프로필의 phone/phone_verified를 직접 갱신. useAuth().phoneVerified/profileLoaded 사용.
- `src/domain/pockets.ts` — 핵심 순수함수: 포켓 목표가, `computePnL`(포켓 순환 대응: 포지션 0이면 원가 리셋), `realizedEvents`(매도 1건별 실현손익), `evaluateSignals`(buy/sell/stop 신호 판정).
- **부분체결**: 15주 주문에 5주만 체결되는 경우 — `auto_orders.filled_qty`(마이그레이션 20260903a)에 체결 누계를 남기고, 전량 체결될 때까지 주문을 `sent` 로 유지한다. 체결분만 trades 에 기록(같은 행 수량을 누계로 갱신)하고 포켓 상태는 전량 체결 뒤에만 bought/sold 로 바꾼다 → 카드에 '남은 수량'이 보이고 취소도 된다. 선점은 `filled_qty < 새 누계` 조건의 단일 UPDATE(원자적)로 중복 기록을 막는다. 부분체결 상태에서 취소하면 매수는 '보유중'(대기중 아님)으로 되돌린다. 클라이언트(`pendingOrders.ts`·`autoTrader.ts`)와 서버 러너 양쪽 동일.
- **미체결 주문 취소**: 매수·매도 모두 포켓 카드의 '🚫 …주문 취소' 버튼, 매수는 주문가 변경 모달에도 '🚫 주문 취소' 버튼(닫기/주문취소/재주문 3개).
- **마지노선(손절)**: 보유중 포켓에 `pockets.stop_price`(마이그레이션 20260813b)를 두면 현재가가 그 아래로 내려갈 때 `stop` 신호 → **현재가로** 전량 매도(마지노선 가격으로 걸면 더 떨어졌을 때 영영 안 팔림). 목표가 수정 모달에서 입력(매도 목표가보다 높으면 저장 차단). 컬럼 없으면 마지노선만 빼고 저장(`src/services/pocketTargets.ts`). 클라이언트 `autoTrader`와 서버 러너 양쪽에 동일 규칙.
- `src/domain/goals.ts` — 인생목표 CAGR. 실제달성액 = 이월 ± 입출금 + 배당금 + 실현손익 (매매일지 자동 연동, 수동입력 없음).
- `src/services/prices/` — 시세 추상화. 기본 Yahoo(키 불필요, 15분 지연, 웹은 CORS 막힘→실기기에서만 라이브). `EXPO_PUBLIC_USE_MOCK=1`로 목업. 한글 종목검색은 Naver(`src/services/symbols.ts`) — Yahoo는 한글 쿼리 400 에러.
- **미국주식 실시간 시세**: priceTracker가 US 프로젝트 + KIS 계좌 연결 + 네이티브면 `getOverseasPrice`(kis.ts, tr HHDFS00000300, 거래소 NAS/NYS/AMS 자동탐색)로 실시간에 가까운 시세를 우선 사용, 실패 시 Yahoo 폴백. 자동 주문은 여전히 KRX만(해외 주문 미구현).
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
