// 포켓 비중(%) 입력칸.
//
// 입력값을 이 컴포넌트가 직접 들고 있는다. 부모 화면은 한 글자 칠 때마다
// 비중 합계·정규화·포켓 미리보기를 전부 다시 계산하는데, 그 리렌더가 입력칸까지 흔들어
// 포커스가 풀리던 문제를 막기 위함이다.
// (20을 지우면 입력칸이 닫히고, 4를 치면 또 닫혀서 0을 따로 쳐야 했던 증상)
//
// 포커스 중에는 부모 값이 들어와도 무시하고, 포커스가 없을 때만
// (균등 분배·포켓 수 변경·초기 로드 등) 부모 값을 따라간다.

import { memo, useEffect, useRef, useState } from 'react';
import { Field } from '@/components/ui';

export const WeightInput = memo(function WeightInput({
  value,
  onChange,
  editable = true,
}: {
  value: string;
  onChange: (v: string) => void;
  editable?: boolean;
}) {
  const [text, setText] = useState(value);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);

  return (
    <Field
      label=""
      value={text}
      editable={editable}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        setText(value);
      }}
      onChangeText={(v) => {
        // 숫자와 소수점만 (소수점은 하나까지)
        const cleaned = v.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
        setText(cleaned);
        onChange(cleaned);
      }}
      keyboardType="decimal-pad"
      selectTextOnFocus // 탭하면 기존 값이 통째로 선택돼 지우지 않고 바로 덮어쓸 수 있다
      returnKeyType="done"
    />
  );
});
