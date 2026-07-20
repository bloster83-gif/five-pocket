import { Alert, Platform } from 'react-native';

// react-native-web 에서는 Alert.alert 가 아무것도 표시하지 않는다.
// 웹에서는 window.alert/confirm 으로, 네이티브에서는 Alert 로 분기한다.

export function notify(title: string, message?: string) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    window.alert(message ? `${title}\n\n${message}` : title);
  } else {
    Alert.alert(title, message);
  }
}

// 3지선다 이상: 네이티브는 Alert 여러 버튼, 웹은 confirm(2지선다)로 첫 실행 옵션만.
export function chooseAction(
  title: string,
  message: string,
  options: { text: string; onPress?: () => void; style?: 'default' | 'cancel' | 'destructive' }[]
) {
  if (Platform.OS === 'web') {
    const primary = options.find((o) => o.style !== 'cancel');
    // eslint-disable-next-line no-alert
    if (primary && window.confirm(`${title}\n\n${message}`)) primary.onPress?.();
    return;
  }
  Alert.alert(
    title,
    message,
    options.map((o) => ({ text: o.text, style: o.style, onPress: o.onPress }))
  );
}

export function confirmAction(
  title: string,
  message: string,
  onConfirm: () => void,
  confirmText = '확인'
) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (window.confirm(`${title}\n\n${message}`)) onConfirm();
  } else {
    Alert.alert(title, message, [
      { text: '취소', style: 'cancel' },
      { text: confirmText, style: 'destructive', onPress: onConfirm },
    ]);
  }
}
