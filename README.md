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

## 배포 (앱스토어/실사용)

- **EAS Build** 로 iOS/Android 빌드: `npm i -g eas-cli` → `eas build`
- 원격 푸시 알림을 쓰려면 `app.json` 에 EAS `projectId` 설정 후
  서버(또는 Supabase Edge Function)에서 저장된 `expo_push_token` 으로 발송

## 주의

이 앱은 **기록·알림 보조 도구**이며 투자 자문이 아닙니다. 실제 주문은 각자 증권사에서 직접 체결하세요.
