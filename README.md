# 5-Pocket — 5분할 매수·매도 일지 (Expo + Supabase)

종목을 **5개 포켓으로 분할 매수/매도**하는 전략을 기록하고, **실시간 시세를 추적**하다가
매수/매도 포인트에 도달하면 **알림**을 보내는 모바일 앱입니다.
여러 사용자가 각자 계정으로 사용하며, 데이터는 Supabase RLS로 완전히 분리됩니다.

## 핵심 기능

- 📉 **5분할 전략 설정** — 매수 간격%(예: 5%, 10%), 매도 목표 수익률%(예: 10%, 15%), 포켓 수(1~10)
- ⏱️ **실시간 시세 추적** — 현재는 목업 제공자로 동작(랜덤 워크). 실제 API로 교체 가능
- 🔔 **매수/매도 포인트 알림** — 현재가가 포켓의 목표가에 도달하면 로컬 푸시 알림
- ✍️ **직접 체결 입력** — 실제 체결가/수량/일시를 사용자가 직접 기록
- 💰 **손익 계산** — 실현/평가 손익 및 수익률 자동 계산
- 👥 **멀티유저** — 이메일 회원가입/로그인, 사용자별 데이터 격리(RLS)

## 폴더 구조

```
five-pocket/
├─ app/                      # 화면(Expo Router, 파일 기반 라우팅)
│  ├─ _layout.tsx            # 루트: 인증 게이트 + 알림 등록
│  ├─ (auth)/                # 로그인 / 회원가입
│  └─ (app)/                 # 로그인 후: 프로젝트 목록 / 생성 / 상세 / 체결입력
├─ src/
│  ├─ domain/pockets.ts      # ★ 5포켓 계산·알림판정·손익 (순수 함수, 앱의 두뇌)
│  ├─ services/prices/       # 시세 제공자 추상화 + 목업 구현 (교체 지점)
│  ├─ services/priceTracker.ts # 실시간 구독 + 알림 발송 훅
│  ├─ lib/                   # supabase, auth, notifications
│  ├─ components/ui.tsx      # 공통 UI
│  └─ types/db.ts            # DB 타입
└─ supabase/schema.sql       # ★ DB 스키마 + 멀티유저 보안(RLS)
```

## 시작하기

### 1. 사전 준비 — Node.js 설치

이 컴퓨터에 Node.js가 없으면 먼저 설치하세요 (LTS 권장):

```powershell
winget install OpenJS.NodeJS.LTS
```

설치 후 **터미널을 새로 열어야** `node`, `npm` 명령이 인식됩니다.

### 2. 의존성 설치

```powershell
cd C:\Users\blost\Desktop\CLAUDE\five-pocket
npm install
npx expo install --fix   # Expo가 SDK에 맞는 정확한 버전으로 정렬
```

### 3. Supabase 프로젝트 만들기

1. https://supabase.com 에서 무료 프로젝트 생성
2. **SQL Editor** 열기 → `supabase/schema.sql` 전체를 붙여넣고 **Run**
   (테이블 5개 + RLS 보안 정책이 한 번에 생성됩니다)
   - 이미 예전 schema.sql 을 실행한 적이 있다면, `supabase/migrations/` 안의 최신
     마이그레이션 SQL도 순서대로 실행하세요 (예산/비율 컬럼 추가).
3. **Project Settings → API** 에서 두 값 복사:
   - `Project URL`
   - `anon public` 키
4. (선택) **Authentication → Providers → Email** 에서 "Confirm email"을
   개발 중엔 꺼두면 회원가입 즉시 로그인됩니다.

### 4. 환경변수 설정

```powershell
copy .env.example .env
```

`.env` 파일을 열어 값을 채웁니다:

```
EXPO_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
```

### 5. 실행

```powershell
npx expo start
```

- **휴대폰**: App Store/Play Store에서 **Expo Go** 설치 → 터미널 QR 스캔
- **웹 미리보기**: 터미널에서 `w`
- **안드로이드 에뮬레이터**: `a` / **iOS 시뮬레이터(맥)**: `i`

> 실제 푸시 알림은 실기기(Expo Go)에서, 로컬 알림은 대부분 환경에서 동작합니다.

## 시세 & 종목 검색 (현재 구현)

키 없이 동작하는 소스를 씁니다:

- **종목 검색** (`src/services/symbols.ts`): 한글 입력 → **Naver 자동완성**, 영문/티커 → **Yahoo 검색**.
  한국(`.KS`/`.KQ`)·미국 종목을 모두 찾고 티커를 자동으로 채웁니다.
- **시세** (`src/services/prices/yahooProvider.ts`): **Yahoo Finance**에서 한국/미국 현재가를
  통화(₩/$)와 함께 5초 폴링. (약 15분 지연 데이터)

> ⚠️ **웹 브라우저에서는 CORS로 검색/시세 호출이 막힙니다.** 실제 폰(Expo Go)·네이티브 빌드에서는 정상 동작합니다.
> 웹에서도 테스트하려면 `.env`에 `EXPO_PUBLIC_YF_PROXY`(CORS 프록시)를 넣거나, `EXPO_PUBLIC_USE_MOCK=1`로 목업 시세를 쓰세요.

### 나중에 진짜 실시간으로 업그레이드

`src/services/prices/index.ts` 한 곳만 바꾸면 됩니다. `PriceProvider` 인터페이스(`getQuote`, `subscribe`)만 구현하면 됩니다.

- **한국 주식** — 한국투자증권 KIS Developers (REST/웹소켓, 개인 무료, 진짜 실시간)
- **미국 주식** — Finnhub 무료 티어 (웹소켓 `trade` 스트림)

## 회원 등급 (Diary / AUTO) & 관리자

- **Diary 등급** — 최초 가입 시 기본 등급. 기존의 수동 매매(알림 + 직접 체결 입력) 버전이 적용됩니다.
- **AUTO 등급** — 관리자가 인증한 회원. 프로젝트별로 **자동 매수/매도**를 켤 수 있습니다.
- **관리자 지정(1회)**: Supabase SQL Editor에서
  ```sql
  update public.profiles set is_admin = true where email = '내이메일@example.com';
  ```
- 관리자로 로그인하면 모든 탭 오른쪽 위에 👑 버튼이 생기고, **회원 관리 페이지**에서
  가입자 목록(이름/이메일/가입일)과 등급을 확인·변경할 수 있습니다.

## 자동매매 (한국투자증권 OpenAPI, AUTO 등급 전용)

1. [KIS Developers](https://apiportal.koreainvestment.com)에서 Open API 신청 → AppKey/AppSecret 발급
   (**모의투자 키로 먼저 테스트**하는 것을 강력 권장)
2. 앱의 프로젝트 상세 → 🤖 자동매매 카드 → **계좌 연결 설정**에서 키/계좌번호 입력 + 연결 테스트
3. 프로젝트 상세에서 **자동매매 스위치 ON** → 실시간 추적 중 포켓의 매수/매도 목표가에 도달하면
   해당 목표가로 **지정가 주문**이 자동 전송되고, 체결 기록과 포켓 상태가 자동 갱신됩니다.

제약 사항:

- 현재 **한국주식(KRX)만** 자동주문을 지원합니다. (미국 주식은 알림만)
- KIS API는 브라우저 CORS를 막으므로 앱 내 자동매매는 **폰(Expo Go)/네이티브 빌드에서만** 동작합니다.
- 주문 이력은 `auto_orders` 테이블에 남고, 실패 시 알림으로 사유를 알려줍니다.

### 24시간 무인 자동매매 (서버 러너)

앱을 꺼 놓아도 서버가 대신 자동매매를 돌리는 방식입니다.
`auto-trade-runner` Edge Function이 1분마다 AUTO 등급 회원의 자동매매 ON 프로젝트를 훑고,
KIS 현재가를 조회해 포켓 신호를 판정 → 주문 → 기록 → **푸시 알림**까지 처리합니다.

설정 (2단계):

1. 함수 배포:
   ```bash
   supabase functions deploy auto-trade-runner
   ```
2. 스케줄 등록: `supabase/migrations/20260716f_auto_trade_cron.sql` 파일을 열어
   `YOUR_PROJECT_REF`와 `YOUR_SERVICE_ROLE_KEY`를 본인 값으로 바꾼 뒤 SQL Editor에서 실행
   (pg_cron이 평일 매 1분 함수를 호출합니다)

동작 방식:

- 장 시간(평일 09:00~15:30 KST) 외에는 함수가 스스로 아무 것도 하지 않습니다.
- 같은 포켓+방향으로는 **10분 내 재주문하지 않아** 중복 주문을 막습니다. 앱(클라이언트)
  자동매매와 동시에 켜져 있어도 이 가드 + 포켓 상태 전환으로 이중 주문을 방지합니다.
- 주문 성공/실패는 `auto_orders`에 기록되고, 앱 알림 권한을 허용했다면
  폰으로 푸시 알림(`profiles.expo_push_token`)이 갑니다.
- 수동 테스트: `.../functions/v1/auto-trade-runner?force=1` 을 service_role 키로 호출하면
  장 시간이 아니어도 1회 실행됩니다.

## 네이버 로그인

Supabase가 네이버를 기본 지원하지 않아 Edge Function이 중계합니다.

1. [네이버 개발자센터](https://developers.naver.com)에서 애플리케이션 등록
   - 사용 API: 네이버 로그인 (이메일 **필수 제공** 동의)
   - Callback URL: `https://<프로젝트>.supabase.co/functions/v1/naver-auth`
2. 함수 배포 + 시크릿 설정 (Supabase CLI):
   ```bash
   supabase functions deploy naver-auth --no-verify-jwt
   supabase secrets set NAVER_CLIENT_ID=... NAVER_CLIENT_SECRET=...
   ```
3. 로그인 화면의 **"네이버로 계속하기"** 버튼으로 로그인(첫 로그인 시 자동 회원가입)됩니다.

## 배포 (앱스토어/실사용)

- **EAS Build** 로 iOS/Android 빌드: `npm i -g eas-cli` → `eas build`
- 원격 푸시 알림을 쓰려면 `app.json` 에 EAS `projectId` 설정 후
  서버(또는 Supabase Edge Function)에서 저장된 `expo_push_token` 으로 발송

## 주의

이 앱은 **기록·알림 보조 도구**이며 투자 자문이 아닙니다. 실제 주문은 각자 증권사에서 직접 체결하세요.
