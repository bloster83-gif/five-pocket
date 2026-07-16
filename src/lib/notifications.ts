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

/** 즉시 로컬 알림 발송 */
export async function notifyNow(title: string, body: string): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: { title, body, sound: true },
    trigger: null,
  });
}
