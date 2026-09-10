import { useEffect, useState, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  colors,
  formatPrice,
  radius,
  rawNumeric,
  signColor,
  spacing,
  withCommas,
} from "@/theme";
import { alignToKrxTick, estimatedShares } from "@/domain/pockets";
import { notify } from "@/lib/alert";
import type { Pocket } from "@/types/db";

// ---------------------------------------------------------------
// 목표 매수·매도가 수정 모달 — 시장 상황을 보며 직접 조정.
//   · 대기중 포켓: 매수 목표가 + 매도 목표가 모두 수정 가능
//   · 보유중 포켓: 이미 매수했으므로 매수 목표가는 '읽기 전용',
//                  매도 목표가 + 마지노선(손절) 가격 수정 가능
//   매수 목표가 → '현재가 대비율', 매도 목표가 → '매수가 대비 수익률' 표시.
//   KRX 는 호가단위(alignToKrxTick)로 정렬해 표시·저장(소수점 방지).
// (프로젝트 상세·포켓탭 공용)
// ---------------------------------------------------------------
// (Section 은 컴포넌트 밖에 둔다 — 안에 두면 글자를 칠 때마다 입력칸이 다시 만들어져 포커스가 풀린다)
/** 한 항목 = 색 띠 + 제목 + 입력 + 한 줄 설명. 항목마다 같은 틀을 써서 화면이 정신없지 않게 한다 */
function Section({
  accent,
  title,
  badge,
  children,
  hint,
  hintColor,
}: {
  accent: string;
  title: string;
  badge?: string;
  children: ReactNode;
  hint?: string | null;
  hintColor?: string;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 10 }}>
      <View
        style={{
          width: 4,
          borderRadius: 2,
          backgroundColor: accent,
          opacity: 0.9,
        }}
      />
      <View style={{ flex: 1, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: accent, fontSize: 13, fontWeight: "900" }}>
            {title}
          </Text>
          {badge ? (
            <View
              style={{
                backgroundColor: colors.cardAlt,
                borderRadius: 6,
                paddingHorizontal: 6,
                paddingVertical: 1,
              }}
            >
              <Text
                style={{
                  color: colors.textDim,
                  fontSize: 10,
                  fontWeight: "800",
                }}
              >
                {badge}
              </Text>
            </View>
          ) : null}
        </View>
        {children}
        {/* 설명 줄은 항상 자리 유지 — 값이 생기고 없어질 때 입력칸이 튀지 않게 */}
        <Text
          numberOfLines={2}
          style={{
            color: hintColor ?? colors.textDim,
            fontSize: 12,
            fontWeight: hintColor ? "700" : "400",
            minHeight: 16,
          }}
        >
          {hint ?? " "}
        </Text>
      </View>
    </View>
  );
}

export function EditTargetsModal({
  visible,
  onClose,
  pocket,
  market,
  price,
  avgBuy,
  onSave,
  projectStop = null,
}: {
  visible: boolean;
  onClose: () => void;
  pocket: Pocket | null;
  market: string;
  price: number | null;
  avgBuy: number; // 보유중이면 평균매수가, 대기중이면 0
  /**
   * buyAt: 정기매수법 포켓의 예정 시각(ISO). 가격 방식 포켓이면 undefined
   * applyStopToAll: '이 프로젝트 전체에 적용' 체크 — 마지노선을 프로젝트 마지노선으로 저장(모든 포켓 + 대기 포켓 매수 보류)
   */
  onSave: (
    buyPrice: number,
    sellPrice: number | null,
    stopPrice: number | null,
    buyAt?: string | null,
    applyStopToAll?: boolean,
  ) => Promise<void>;
  /** 프로젝트 마지노선 — 포켓에 따로 없으면 이 값을 보여준다 */
  projectStop?: number | null;
}) {
  const isKrx = market === "KRX";
  const dec = !isKrx; // 미국주식은 소수점 허용
  const held = avgBuy > 0; // 보유중이면 매수 목표가 수정 불가
  const [buyStr, setBuyStr] = useState("");
  const [sellStr, setSellStr] = useState("");
  const [stopStr, setStopStr] = useState("");
  // 마지노선을 이 포켓만이 아니라 프로젝트 전체에 — 대기중 포켓은 포켓 단독 마지노선이 의미가 없어 항상 전체 적용
  const [stopAll, setStopAll] = useState(false);
  const [saving, setSaving] = useState(false);
  // 정기매수법 포켓(대기중)은 매수 목표가 대신 '언제 살지'를 고친다
  const scheduled = !held && !!pocket?.buy_at;
  const [dateStr, setDateStr] = useState("");
  const [timeStr, setTimeStr] = useState("");

  useEffect(() => {
    if (visible && pocket) {
      // 저장된 값을 KRX 호가단위로 정렬해 정수로 표시(40757.1 → 40800, 소수점/버그 방지)
      const b = pocket.buy_target_price;
      const s = pocket.sell_target_price;
      // 포켓에 마지노선이 없으면 프로젝트 마지노선을 보여준다 (그게 지금 실제로 적용되는 값)
      const ownStop =
        pocket.stop_price != null && Number(pocket.stop_price) > 0;
      const st = ownStop ? pocket.stop_price : projectStop;
      setStopAll(!ownStop && (projectStop != null || avgBuy <= 0));
      const bA = b != null ? (isKrx ? alignToKrxTick(b, "buy") : b) : null;
      const sA = s != null ? (isKrx ? alignToKrxTick(s, "sell") : s) : null;
      // 마지노선은 매도 주문이므로 매도 쪽 호가로 정렬
      const stA =
        st != null && Number(st) > 0
          ? isKrx
            ? alignToKrxTick(Number(st), "sell")
            : Number(st)
          : null;
      setBuyStr(bA != null ? String(bA) : "");
      setSellStr(sA != null ? String(sA) : "");
      setStopStr(stA != null ? String(stA) : "");
      if (pocket.buy_at) {
        const d = new Date(pocket.buy_at);
        const p2 = (n: number) => String(n).padStart(2, "0");
        setDateStr(
          `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
        );
        setTimeStr(`${p2(d.getHours())}:${p2(d.getMinutes())}`);
      }
    }
  }, [
    visible,
    pocket?.buy_target_price,
    pocket?.sell_target_price,
    pocket?.stop_price,
    pocket?.buy_at,
    isKrx,
    projectStop,
    avgBuy,
  ]);

  if (!pocket) return null;

  const buyInput = Number(rawNumeric(buyStr, dec)) || 0;
  const sellInput = Number(rawNumeric(sellStr, dec)) || 0;
  const stopInput = Number(rawNumeric(stopStr, dec)) || 0;

  // 실제 저장/주문에 쓰일 값 = KRX 호가단위 정렬
  const existingBuy =
    pocket.buy_target_price != null
      ? isKrx
        ? alignToKrxTick(pocket.buy_target_price, "buy")
        : pocket.buy_target_price
      : 0;
  const buyVal = held
    ? existingBuy
    : isKrx
      ? alignToKrxTick(buyInput, "buy")
      : buyInput;
  const sellVal =
    sellInput > 0 ? (isKrx ? alignToKrxTick(sellInput, "sell") : sellInput) : 0;
  const stopVal =
    stopInput > 0 ? (isKrx ? alignToKrxTick(stopInput, "sell") : stopInput) : 0;

  // 매수 목표가: 현재가 대비 (목표가가 현재가보다 얼마나 낮은지/높은지)
  const buyVsNow =
    price != null && price > 0 && buyVal > 0
      ? Math.round((buyVal / price - 1) * 1000) / 10
      : null;
  // 매도 목표가: 매수가 대비 수익률 (보유중=평단, 대기중=매수 목표가 기준)
  const refBuy = held ? avgBuy : buyVal;
  const sellProfit =
    refBuy > 0 && sellVal > 0
      ? Math.round((sellVal / refBuy - 1) * 1000) / 10
      : null;
  const cur = isKrx ? "₩" : "$";

  // 배분 예산으로 이 목표가에 몇 주를 살 수 있는지.
  // 0주가 되면 목록에서 숨겨져 포켓이 사라진 것처럼 보이므로 저장 자체를 막는다.
  // (보유중 포켓은 매수 목표가를 못 바꾸므로 검사 대상이 아니다)
  const buyableQty = held
    ? null
    : estimatedShares(
        pocket.budget,
        scheduled && price != null && price > 0 ? price : buyVal,
      );
  const qtyBlocked = buyableQty != null && buyVal > 0 && buyableQty <= 0;

  // 마지노선 — 평균매수가 대비 손익률, 그리고 잘못 넣었을 때의 경고
  const stopProfit =
    avgBuy > 0 && stopVal > 0
      ? Math.round((stopVal / avgBuy - 1) * 1000) / 10
      : null;
  // 매도 목표가보다 높으면 매도가 아니라 손절이 먼저 걸려버린다
  const stopAboveSell = stopVal > 0 && sellVal > 0 && stopVal >= sellVal;
  // 이미 현재가가 마지노선 아래면 저장하는 순간 바로 매도된다
  const stopHitNow =
    stopVal > 0 && price != null && price > 0 && price <= stopVal;

  const submit = async () => {
    if (buyVal <= 0)
      return notify("입력 확인", "매수 목표가를 올바르게 입력해 주세요.");
    // 정기매수법: 예정 시각을 다시 계산해 넘긴다 (형식이 어긋나면 막는다)
    let buyAt: string | null | undefined = undefined;
    if (scheduled) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
      const t = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
      if (!m || !t)
        return notify(
          "입력 확인",
          "날짜는 YYYY-MM-DD, 시각은 HH:MM 형식으로 입력해 주세요.",
        );
      const d = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(t[1]),
        Number(t[2]),
        0,
        0,
      );
      if (isNaN(d.getTime()))
        return notify("입력 확인", "날짜·시각을 확인해 주세요.");
      buyAt = d.toISOString();
    }
    if (stopAboveSell) {
      return notify(
        "저장할 수 없어요",
        `마지노선(${formatPrice(stopVal, market)})이 매도 목표가(${formatPrice(sellVal, market)})보다 높아요.\n\n` +
          "마지노선은 매도 목표가보다 낮게 넣어 주세요.",
      );
    }
    if (qtyBlocked) {
      return notify(
        "저장할 수 없어요",
        `배분 예산 ${formatPrice(Number(pocket.budget ?? 0), market)}으로는 ${formatPrice(buyVal, market)}에 1주도 살 수 없어요.\n\n` +
          "매수 목표가를 낮추거나, 프로젝트 예산을 늘려 주세요.",
      );
    }
    setSaving(true);
    try {
      await onSave(
        buyVal,
        sellVal > 0 ? sellVal : null,
        stopVal > 0 ? stopVal : null,
        buyAt,
        held ? stopAll : true,
      );
    } catch (e: any) {
      notify("저장 실패", e?.message ?? "목표가를 저장하지 못했어요.");
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 11,
    color: colors.text,
    fontSize: 17,
    fontWeight: "900" as const,
    backgroundColor: colors.bg,
  };

  const pctText = (v: number | null, prefix: string, suffix = "") =>
    v == null ? null : `${prefix} ${v > 0 ? "+" : ""}${v}%${suffix}`;

  // 경고는 한 곳에 모아 보여준다 (항목마다 흩어져 있으면 정신없다)
  const warnings: string[] = [];
  if (stopAboveSell)
    warnings.push(
      `마지노선(${formatPrice(stopVal, market)})이 매도 목표가보다 높아요. 매도 목표가보다 낮게 넣어 주세요.`,
    );
  else if (stopHitNow)
    warnings.push(
      `현재가(${formatPrice(price!, market)})가 이미 마지노선 이하예요. ${held ? "저장하면 곧바로 매도 주문이 나갑니다." : "저장하면 가격이 선 위로 올라올 때까지 매수하지 않아요."}`,
    );
  if (qtyBlocked)
    warnings.push(
      `배분 예산 ${formatPrice(Number(pocket.budget ?? 0), market)}으로는 ${formatPrice(buyVal, market)}에 1주도 살 수 없어 저장할 수 없어요.`,
    );
  const krxNote = (input: number, val: number) =>
    isKrx && val > 0 && input !== val
      ? ` · 호가단위 → ${formatPrice(val, market)}`
      : "";
  const blocked = qtyBlocked || stopAboveSell;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <Pressable
          onPress={onClose}
          style={{
            flex: 1,
            backgroundColor: "rgba(0,0,0,0.6)",
            justifyContent: "center",
            padding: spacing.lg,
          }}
        >
          <Pressable
            onPress={() => {}}
            style={{
              backgroundColor: colors.card,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: colors.border,
              maxHeight: "90%",
              overflow: "hidden",
            }}
          >
            {/* 머리: 제목 + 닫기 */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingHorizontal: spacing.lg,
                paddingVertical: 14,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
              }}
            >
              <View>
                <Text
                  style={{
                    color: colors.text,
                    fontWeight: "900",
                    fontSize: 17,
                  }}
                >
                  🎯 포켓 {pocket.idx + 1} 목표 수정
                </Text>
                <Text
                  style={{ color: colors.textDim, fontSize: 11, marginTop: 2 }}
                >
                  {held
                    ? "보유중 · 매도 목표가와 마지노선을 조정"
                    : scheduled
                      ? "대기중 · 예정 시각과 매도 목표가를 조정"
                      : "대기중 · 매수·매도 목표가를 조정"}
                </Text>
              </View>
              <Pressable
                onPress={onClose}
                hitSlop={10}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 15,
                  backgroundColor: colors.cardAlt,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text
                  style={{
                    color: colors.textDim,
                    fontSize: 15,
                    fontWeight: "900",
                  }}
                >
                  ✕
                </Text>
              </Pressable>
            </View>

            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
            >
              {/* 기준 숫자 한 줄 — 현재가 · 평균매수가 */}
              <View style={{ flexDirection: "row", gap: spacing.sm }}>
                <View
                  style={{
                    flex: 1,
                    backgroundColor: colors.cardAlt,
                    borderRadius: radius.md,
                    padding: 10,
                  }}
                >
                  <Text style={{ color: colors.textDim, fontSize: 11 }}>
                    현재가
                  </Text>
                  <Text
                    style={{
                      color: colors.text,
                      fontSize: 16,
                      fontWeight: "900",
                    }}
                  >
                    {price != null ? formatPrice(price, market) : "-"}
                  </Text>
                </View>
                {held && (
                  <View
                    style={{
                      flex: 1,
                      backgroundColor: colors.cardAlt,
                      borderRadius: radius.md,
                      padding: 10,
                    }}
                  >
                    <Text style={{ color: colors.textDim, fontSize: 11 }}>
                      평균매수가
                    </Text>
                    <Text
                      style={{
                        color: colors.text,
                        fontSize: 16,
                        fontWeight: "900",
                      }}
                    >
                      {formatPrice(avgBuy, market)}
                    </Text>
                  </View>
                )}
                {!held && buyableQty != null && buyVal > 0 && (
                  <View
                    style={{
                      flex: 1,
                      backgroundColor: qtyBlocked
                        ? "rgba(251,191,36,0.12)"
                        : colors.cardAlt,
                      borderRadius: radius.md,
                      padding: 10,
                    }}
                  >
                    <Text style={{ color: colors.textDim, fontSize: 11 }}>
                      매수 가능 수량
                    </Text>
                    <Text
                      style={{
                        color: qtyBlocked ? colors.warn : colors.buy,
                        fontSize: 16,
                        fontWeight: "900",
                      }}
                    >
                      {buyableQty}주
                    </Text>
                  </View>
                )}
              </View>

              {/* ① 매수 — 대기중: 목표가 / 정기: 예정 시각 / 보유중: 읽기 전용 */}
              {scheduled ? (
                <Section
                  accent={colors.buy}
                  title="📅 매수 예정"
                  badge="한국시간"
                  hint="이 시각이 지나면 그때 현재가로 살 수 있는 최대 수량을 주문해요. 장이 닫혀 있으면 열릴 때까지 기다려요."
                >
                  <View style={{ flexDirection: "row", gap: spacing.sm }}>
                    <TextInput
                      value={dateStr}
                      onChangeText={setDateStr}
                      placeholder="YYYY-MM-DD"
                      placeholderTextColor={colors.textDim}
                      autoCapitalize="none"
                      style={[inputStyle, { flex: 1.4 }]}
                    />
                    <TextInput
                      value={timeStr}
                      onChangeText={setTimeStr}
                      placeholder="09:30"
                      placeholderTextColor={colors.textDim}
                      autoCapitalize="none"
                      style={[inputStyle, { flex: 1 }]}
                    />
                  </View>
                </Section>
              ) : held ? (
                <Section
                  accent={colors.buy}
                  title="매수 목표가"
                  badge="완료"
                  hint="이미 매수한 포켓이라 바꿀 수 없어요."
                >
                  <View style={[inputStyle, { opacity: 0.55 }]}>
                    <Text
                      style={{
                        color: colors.textDim,
                        fontSize: 17,
                        fontWeight: "900",
                      }}
                    >
                      {formatPrice(existingBuy, market)}
                    </Text>
                  </View>
                </Section>
              ) : (
                <Section
                  accent={colors.buy}
                  title="매수 목표가"
                  hint={
                    (pctText(buyVsNow, "현재가 대비") ??
                      "이 가격 이하로 내려오면 매수해요.") +
                    krxNote(buyInput, buyVal)
                  }
                  hintColor={buyVsNow != null ? signColor(buyVsNow) : undefined}
                >
                  <TextInput
                    value={withCommas(buyStr, dec)}
                    onChangeText={(t) => setBuyStr(rawNumeric(t, dec))}
                    keyboardType="numeric"
                    placeholder={`매수 목표가 (${cur})`}
                    placeholderTextColor={colors.textDim}
                    style={inputStyle}
                  />
                </Section>
              )}

              {/* ② 매도 목표가 */}
              <Section
                accent={colors.sell}
                title="매도 목표가"
                hint={
                  (pctText(
                    sellProfit,
                    `${held ? "평균매수가" : "매수 목표가"} 대비`,
                  ) ?? "이 가격 이상으로 오르면 매도해요.") +
                  krxNote(sellInput, sellVal)
                }
                hintColor={
                  sellProfit != null ? signColor(sellProfit) : undefined
                }
              >
                <TextInput
                  value={withCommas(sellStr, dec)}
                  onChangeText={(t) => setSellStr(rawNumeric(t, dec))}
                  keyboardType="numeric"
                  placeholder={`매도 목표가 (${cur})`}
                  placeholderTextColor={colors.textDim}
                  style={inputStyle}
                />
              </Section>

              {/* ③ 마지노선 */}
              <Section
                accent={colors.warn}
                title="🛑 마지노선"
                badge={held ? "손절가" : "프로젝트 전체"}
                hint={
                  (stopProfit != null
                    ? pctText(
                        stopProfit,
                        "평균매수가 대비",
                        stopProfit >= 0 ? " · 최소 이익 확보" : " · 손실 제한",
                      )
                    : held
                      ? "이 가격 이하로 내려가면 전량 매도해요. 비워 두면 사용 안 함."
                      : "이 가격 이하면 모든 포켓이 매수를 보류하고 보유 포켓은 전량 매도해요. 비워 두면 사용 안 함.") +
                  krxNote(stopInput, stopVal)
                }
                hintColor={
                  stopProfit != null ? signColor(stopProfit) : undefined
                }
              >
                <TextInput
                  value={withCommas(stopStr, dec)}
                  onChangeText={(t) => setStopStr(rawNumeric(t, dec))}
                  keyboardType="numeric"
                  placeholder={`비워 두면 사용 안 함 (${cur})`}
                  placeholderTextColor={colors.textDim}
                  style={[
                    inputStyle,
                    stopAboveSell ? { borderColor: colors.warn } : null,
                  ]}
                />
                {held && (
                  <Pressable
                    onPress={() => setStopAll((v) => !v)}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                      paddingVertical: 8,
                      paddingHorizontal: 10,
                      borderRadius: radius.md,
                      backgroundColor: stopAll
                        ? "rgba(251,191,36,0.10)"
                        : colors.cardAlt,
                    }}
                  >
                    <View
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 5,
                        borderWidth: 2,
                        borderColor: stopAll ? colors.warn : colors.textDim,
                        backgroundColor: stopAll ? colors.warn : "transparent",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {stopAll && (
                        <Text
                          style={{
                            color: "#04121A",
                            fontSize: 13,
                            fontWeight: "900",
                            lineHeight: 16,
                          }}
                        >
                          ✓
                        </Text>
                      )}
                    </View>
                    <Text
                      style={{
                        color: stopAll ? colors.warn : colors.text,
                        fontSize: 13,
                        fontWeight: "800",
                        flex: 1,
                      }}
                    >
                      이 프로젝트 전체에 적용
                    </Text>
                    <Text style={{ color: colors.textDim, fontSize: 11 }}>
                      {stopAll ? "모든 포켓" : "이 포켓만"}
                    </Text>
                  </Pressable>
                )}
              </Section>

              {/* 경고 모음 */}
              {warnings.length > 0 && (
                <View
                  style={{
                    backgroundColor: "rgba(251,191,36,0.10)",
                    borderRadius: radius.md,
                    padding: spacing.md,
                    gap: 4,
                    borderWidth: 1,
                    borderColor: colors.warn,
                  }}
                >
                  {warnings.map((w, i) => (
                    <Text
                      key={i}
                      style={{
                        color: colors.warn,
                        fontSize: 12,
                        fontWeight: "700",
                      }}
                    >
                      ⚠️ {w}
                    </Text>
                  ))}
                </View>
              )}
            </ScrollView>

            {/* 발: 취소 / 저장 */}
            <View
              style={{
                flexDirection: "row",
                gap: spacing.sm,
                padding: spacing.lg,
                paddingTop: spacing.md,
                borderTopWidth: 1,
                borderTopColor: colors.border,
              }}
            >
              <Pressable
                onPress={onClose}
                style={{
                  flex: 1,
                  paddingVertical: 13,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: colors.border,
                  alignItems: "center",
                }}
              >
                <Text style={{ color: colors.textDim, fontWeight: "800" }}>
                  취소
                </Text>
              </Pressable>
              <Pressable
                onPress={submit}
                disabled={saving || blocked}
                style={{
                  flex: 2,
                  paddingVertical: 13,
                  borderRadius: radius.md,
                  backgroundColor: blocked ? colors.border : colors.primary,
                  alignItems: "center",
                  opacity: saving ? 0.6 : 1,
                }}
              >
                <Text
                  style={{
                    color: blocked ? colors.textDim : "#04121A",
                    fontWeight: "900",
                  }}
                >
                  {saving ? "저장 중…" : "저장"}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
