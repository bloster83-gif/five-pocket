# AUTO 등급 인앱결제(IAP) 설정 가이드

Diary 등급은 **무료**, AUTO 등급만 **인앱결제(RevenueCat)** 로 판매합니다.
코드는 이미 붙어 있고, 아래는 **스토어·RevenueCat 대시보드에서 직접 해야 하는 설정**입니다.

결제가 되면 RevenueCat 웹훅이 서버로 알려주고, 서버가 자동으로 `profiles.tier='auto'` 로 바꿉니다.
(관리자 수동 등급 변경 기능 `admin.tsx` 은 그대로 유지 — 무료 지급/연장 가능)

---

## 0. 선행 조건
- Apple: **유료 앱 계약(Paid Apps Agreement)** 동의 + 은행/세금 정보 입력
  - App Store Connect → **비즈니스(Business)** → 계약/세금/뱅킹 전부 "활성"
  - 이게 안 되어 있으면 구독 상품이 심사에 안 올라갑니다.
- Google: Play Console → **결제 프로필/판매자 계정** 설정

## 1. 스토어에 구독 상품 만들기
같은 **상품 ID** 를 양쪽에 동일하게 만드는 걸 권장합니다. 예:

| 기간 | 상품 ID(예시) |
|---|---|
| 1개월 | `auto_monthly` |
| 6개월 | `auto_6month` |
| 12개월 | `auto_yearly` |

- **App Store Connect** → 앱 → 수익 창출 → **구독(Subscriptions)** → 구독 그룹 1개 생성 → 위 3개 자동 갱신 구독 추가(가격·기간 설정)
- **Google Play Console** → 앱 → 수익 창출 → **구독** → 동일하게 3개 생성

> 자동 갱신 구독이 기본입니다. (해지 전까지 자동 청구, 만료 시 앱이 자동으로 다이어리로 강등)

## 2. RevenueCat 설정
1. https://www.revenuecat.com 가입 → 프로젝트 생성
2. **Apps** 에 iOS 앱(App Store, 번들 `com.fivepocket.app`) + Android 앱(Play, 패키지 `com.fivepocket.app`) 등록
   - iOS: App Store Connect의 **In-App Purchase Key(.p8)** 업로드
   - Android: Google Play **서비스 계정 JSON** 연결
3. **Products** 에 1번에서 만든 상품 ID 3개 등록
4. **Entitlements** 에서 식별자 **`auto`** 생성 → 상품 3개를 모두 이 entitlement 에 연결
   - ⚠️ 코드가 `auto` 라는 이름을 쓰므로 **정확히 `auto`** 로 만들어야 합니다.
5. **Offerings** → Current offering 하나 만들고 → **Packages** 에 Monthly / 6-month(커스텀) / Annual 로 상품 3개 배치
6. **API keys** → "Public app-specific API keys" 복사:
   - iOS 키(`appl_...`) → 환경변수 `EXPO_PUBLIC_RC_IOS_KEY`
   - Android 키(`goog_...`) → 환경변수 `EXPO_PUBLIC_RC_ANDROID_KEY`
   - `eas.json` 의 build.production.env 에 넣거나 `.env` 에 넣습니다. (공개 키라 노출 안전)

## 3. 웹훅(결제 → 자동 등급 전환) 배포
```bash
# 웹훅 인증용 임의의 긴 문자열을 하나 정해 시크릿으로 저장
supabase secrets set RC_WEBHOOK_AUTH="아무거나-긴-랜덤-문자열-1234"

# 함수 배포 (JWT 검증 끄기 — RevenueCat 서버가 직접 호출)
supabase functions deploy revenuecat-webhook --no-verify-jwt
```
그다음 RevenueCat 대시보드 → **Integrations → Webhooks**:
- **URL**: `https://<PROJECT_REF>.functions.supabase.co/revenuecat-webhook`
- **Authorization header**: 위에서 정한 `RC_WEBHOOK_AUTH` 와 **똑같은 값**

## 4. 앱 다시 빌드
환경변수(RC 키)를 넣은 뒤 다시 빌드해야 결제가 동작합니다. (Expo Go ❌, 정식 빌드만)
```bash
eas build --platform ios --profile production
eas build --platform android --profile production
```

## 5. 테스트
- iOS: App Store Connect → **Sandbox 테스터** 계정으로 TestFlight 에서 결제 테스트(실제 청구 없음)
- Android: Play Console → **라이선스 테스터** 등록 후 내부 테스트에서 결제

---

## 동작 요약
1. 사용자가 앱의 "이용권 구매" 에서 기간 선택 → 스토어 결제창
2. 결제 성공 → RevenueCat 이 영수증 검증 → `auto` entitlement 활성
3. RevenueCat 웹훅 → `revenuecat-webhook` → `profiles.tier='auto'`, 만료일 저장
4. 앱이 프로필을 새로고침 → AUTO 기능(자동매매) 활성화
5. 만료/해지 → 웹훅이 `diary` 로 강등 (앱·서버 러너도 만료 재검사)

## 키/시크릿 정리
| 이름 | 위치 | 공개 여부 |
|---|---|---|
| `EXPO_PUBLIC_RC_IOS_KEY` / `EXPO_PUBLIC_RC_ANDROID_KEY` | eas.json / .env | 공개 키(안전) |
| `RC_WEBHOOK_AUTH` | supabase secrets | **비밀** |
| App Store In-App Purchase Key(.p8) | RevenueCat 에만 업로드 | **비밀** |
| Google 서비스 계정 JSON | RevenueCat 에만 업로드 | **비밀** |
