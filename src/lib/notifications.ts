import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { supabase } from './supabase';

// 포그라운드에서도 알림 배너를 표시
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * 알림 권한 요청 + (실기기라면) Expo 푸시 토큰을 profiles 에 저장.
 * 웹/시뮬레이터에서는 로컬 알림만 동작하고 조용히 넘어간다.
 */
export async function registerForNotifications(userId: string | undefined): Promise<void> {
  // 사용자가 MY 탭에서 알림을 꺼뒀으면 앱 시작 시 재등록하지 않음 (설정 유지)
  if (!(await getNotificationsEnabled())) return;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#22D3A6',
    });
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  let status = existing;
  if (existing !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') return;

  // 원격 푸시 토큰은 실기기에서만 발급됨
  if (!Device.isDevice || !userId) return;
  try {
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;
    const token = (
      await Notifications.getExpoPushTokenAsync(
        projectId ? { projectId } : undefined
      )
    ).data;
    await supabase.from('profiles').update({ expo_push_token: token }).eq('id', userId);
  } catch {
    // EAS projectId 미설정 등은 무시 (로컬 알림은 계속 동작)
  }
}

// ---- 알림 켜기/끄기 (MY 탭 설정) ----
// 끄면: 로컬 알림 발송 중단 + profiles.expo_push_token 을 지워 서버 푸시(러너)도 차단.
// 켜면: 다시 권한/토큰 등록.
import AsyncStorage from '@react-native-async-storage/async-storage';
const NOTI_KEY = 'notifications_enabled';

export async function getNotificationsEnabled(): Promise<boolean> {
  try {
    return ((await AsyncStorage.getItem(NOTI_KEY)) ?? '1') === '1';
  } catch {
    return true;
  }
}

export async function setNotificationsEnabled(userId: string | undefined, enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(NOTI_KEY, enabled ? '1' : '0');
  } catch {
    /* 저장 실패해도 아래 토큰 처리는 진행 */
  }
  if (enabled) {
    await registerForNotifications(userId); // 푸시 토큰 재등록
  } else if (userId) {
    // 서버(24시간 러너) 푸시도 못 오게 토큰 제거
    await supabase.from('profiles').update({ expo_push_token: null }).eq('id', userId);
  }
}

/** 즉시 로컬 알림 발송 (알림 꺼짐 설정이면 무시) */
export async function notifyNow(title: string, body: string): Promise<void> {
  if (!(await getNotificationsEnabled())) return;
  await Notifications.scheduleNotificationAsync({
    content: { title, body, sound: true },
    trigger: null,
  });
}
