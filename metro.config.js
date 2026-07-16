// Metro 설정 (Expo 기본값 확장)
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// @supabase/supabase-js 는 @opentelemetry/api 를 "선택적으로" 동적 import 하는데,
// Metro 는 이를 정적으로 해석하려다 실패한다. 우리는 이 계측 기능을 쓰지 않으므로
// 빈 모듈로 치환한다. (Supabase 버전이 올라가도 안전)
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@opentelemetry/api') {
    return { type: 'empty' };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
