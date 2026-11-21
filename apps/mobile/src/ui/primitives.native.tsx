import { type ReactNode, useEffect, useRef, useState } from "react";
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type {
  ActionProps,
  ChoiceCardProps,
  FooterProps,
  GuideProps,
  LoupeProps,
  ScrubberProps,
  StatProps,
  StepperProps,
} from "./primitive-types.js";
import { colors } from "./theme.js";
import { skeletonSegments } from "./visual-data.js";

export {
  SkeletonCanvas2D,
  SkeletonPreview3D,
  TrendChart,
  WaveformChart,
} from "./visuals.native.js";

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.canvas },
  content: { padding: 14, gap: 12 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6 },
  brand: { flexDirection: "row", alignItems: "center", gap: 6 },
  icon: {
    padding: 7,
    borderRadius: 8,
    backgroundColor: colors.tint,
    color: colors.accent,
    fontWeight: "800",
  },
  brandIcon: {
    padding: 7,
    borderRadius: 8,
    backgroundColor: colors.dark,
    color: "#5eead4",
    fontWeight: "800",
  },
  brandName: { fontSize: 17, fontWeight: "800", color: colors.ink },
  small: { fontSize: 11, color: colors.secondary },
  stepper: {
    flexDirection: "row",
    gap: 4,
    padding: 4,
    backgroundColor: colors.surface,
    borderRadius: 13,
  },
  step: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    minHeight: 57,
    borderRadius: 9,
  },
  stepNumber: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 12,
    fontWeight: "700",
    color: colors.secondary,
    backgroundColor: colors.canvas,
    overflow: "hidden",
  },
  panel: {
    padding: 13,
    gap: 10,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    elevation: 2,
    shadowColor: colors.ink,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
  },
  title: { fontSize: 27, fontWeight: "800", color: colors.ink },
  heading: { fontSize: 16, fontWeight: "800", color: colors.ink },
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  grid: { gap: 10 },
  copy: { color: colors.secondary, fontSize: 14, lineHeight: 21 },
  guide: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    padding: 10,
    borderRadius: 11,
    backgroundColor: colors.tint,
    borderColor: colors.border,
    borderWidth: 1,
  },
  notice: { padding: 10, borderRadius: 9, backgroundColor: colors.warningSurface },
  action: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingHorizontal: 9,
    paddingVertical: 6,
    minHeight: 42,
    borderWidth: 1.5,
    borderColor: colors.outline,
    justifyContent: "center",
  },
  actionLabel: { fontWeight: "700", fontSize: 12, color: colors.ink, textAlign: "center" },
  stat: {
    flex: 1,
    minWidth: 0,
    padding: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.surface,
  },
  choice: {
    flex: 1,
    gap: 4,
    borderWidth: 1,
    borderColor: colors.outline,
    padding: 8,
    borderRadius: 10,
    backgroundColor: colors.surface,
    minHeight: 62,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    padding: 7,
    gap: 4,
    borderRadius: 13,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  lineCard: { backgroundColor: colors.dark, minHeight: 140, padding: 16, gap: 7, borderRadius: 13 },
  link: { color: colors.accent, textDecorationLine: "underline", fontSize: 16 },
});

export function Page({ children, focusKey }: { children: ReactNode; focusKey?: string }) {
  const scroll = useRef<ScrollView>(null);
  useEffect(() => {
    if (!focusKey) return;
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [focusKey]);
  return (
    <SafeAreaView style={styles.page}>
      <ScrollView ref={scroll} contentContainerStyle={styles.content}>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Header({ children }: { children: ReactNode }) {
  return (
    <View style={styles.header}>
      <View style={styles.brand}>
        <Text style={styles.brandIcon} accessible={false}>
          ∿
        </Text>
        <View>
          <Text style={styles.brandName}>Sports Motion</Text>
          <Text style={[styles.small, { fontSize: 9 }]}>3D動作解析・コーチング</Text>
        </View>
      </View>
      <View style={[styles.row, { flexShrink: 1, justifyContent: "flex-end" }]}>{children}</View>
    </View>
  );
}

export function Stepper({ steps, active, visited, onSelect }: StepperProps) {
  return (
    <View style={styles.stepper} accessibilityLabel="解析の進捗">
      {steps.map((label, index) => (
        <Pressable
          key={label}
          accessibilityRole="button"
          accessibilityState={{ selected: active === index }}
          onPress={() => onSelect(index)}
          style={[styles.step, active === index && { backgroundColor: colors.tint }]}
        >
          <Text
            style={[
              styles.stepNumber,
              active === index && { backgroundColor: colors.accent, color: colors.surface },
              index !== active &&
                visited.has(index) && {
                  backgroundColor: colors.successSurface,
                  color: colors.success,
                },
            ]}
          >
            {index !== active && visited.has(index) ? "✓" : index + 1}
          </Text>
          <Text style={[styles.small, { textAlign: "center" }]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.panel}>
      <Text accessibilityRole="header" style={styles.heading}>
        {title}
      </Text>
      {children}
    </View>
  );
}

export function Title({ children, subtitle }: { children: string; subtitle?: string }) {
  return (
    <View>
      <Text accessibilityRole="header" style={styles.title}>
        {children}
      </Text>
      {subtitle && <Text style={styles.small}>{subtitle}</Text>}
    </View>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

export function Grid({
  children,
  layout,
}: {
  children: ReactNode;
  layout?: "split" | "equal" | "choices";
}) {
  return (
    <View style={layout === "choices" ? [styles.row, { alignItems: "stretch" }] : styles.grid}>
      {children}
    </View>
  );
}

export function ViewSlot({ children, hidden }: { children: ReactNode; hidden: boolean }) {
  return <View style={hidden ? { display: "none" } : styles.grid}>{children}</View>;
}

export function Copy({ children }: { children: ReactNode }) {
  return <Text style={styles.copy}>{children}</Text>;
}

export function Notice({
  children,
  nonDiagnostic = false,
  tone = "warning",
}: {
  children: string;
  nonDiagnostic?: boolean;
  tone?: "warning" | "success";
}) {
  return (
    <View
      accessibilityLiveRegion={nonDiagnostic ? "none" : "polite"}
      testID={nonDiagnostic ? "non-diagnostic" : "status"}
      style={[
        styles.notice,
        tone === "success" && { backgroundColor: colors.successSurface },
        nonDiagnostic && { backgroundColor: "#eef2f6" },
      ]}
    >
      <Text
        style={[
          styles.small,
          {
            color: nonDiagnostic
              ? colors.secondary
              : tone === "success"
                ? "#065f46"
                : colors.warning,
          },
        ]}
      >
        {children}
      </Text>
    </View>
  );
}

export function Action({
  children,
  onPress,
  selected,
  disabled = false,
  variant = "secondary",
}: ActionProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, ...(selected !== undefined && { selected }) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        variant === "ghost" && { backgroundColor: "transparent", borderColor: "transparent" },
        variant === "chip" && { borderRadius: 999, minHeight: 36 },
        variant === "primary" && { backgroundColor: colors.accent, borderColor: colors.accent },
        selected && { backgroundColor: colors.tint, borderColor: colors.accent },
        (disabled || pressed) && { opacity: disabled ? 0.48 : 0.78 },
      ]}
    >
      <Text
        style={[
          styles.actionLabel,
          variant === "primary" && { color: colors.surface },
          selected && { color: colors.accent },
        ]}
      >
        {children}
      </Text>
    </Pressable>
  );
}

export function Footer({ onBack, children }: FooterProps) {
  return (
    <View style={styles.footer}>
      {onBack && (
        <Action variant="ghost" onPress={onBack}>
          ← 戻る
        </Action>
      )}
      <View style={[styles.row, { marginLeft: "auto", flexShrink: 1, justifyContent: "flex-end" }]}>
        {children}
      </View>
    </View>
  );
}

export function ChoiceCard({ label, description, icon, selected, onPress }: ChoiceCardProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.choice,
        selected && { backgroundColor: colors.tint, borderColor: colors.accent },
      ]}
    >
      <Text accessible={false} style={styles.icon}>
        {icon}
      </Text>
      <Text style={[styles.small, { fontWeight: "800", color: colors.ink }]}>{label}</Text>
      <Text style={styles.small}>{description}</Text>
    </Pressable>
  );
}

export function GuideBanner({ badge, children, tone = "default" }: GuideProps) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        styles.guide,
        tone === "warning" && { backgroundColor: colors.warningSurface },
        tone === "success" && { backgroundColor: colors.successSurface },
      ]}
    >
      <Text style={styles.icon}>{badge}</Text>
      <View style={{ flex: 1 }}>
        <Text style={[styles.small, { fontWeight: "800" }]}>次にやること</Text>
        <Text style={styles.small}>{children}</Text>
      </View>
    </View>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <View style={[styles.row, { alignItems: "stretch" }]}>{children}</View>;
}

export function StatCard({ label, value, unit, trend }: StatProps) {
  return (
    <View style={styles.stat}>
      <Text style={styles.small}>{label}</Text>
      <Text style={[styles.heading, { fontSize: 23 }]}>
        {value} <Text style={styles.small}>{unit}</Text>
      </Text>
      {trend && <Text style={[styles.small, { color: colors.accent }]}>{trend}</Text>}
    </View>
  );
}

export function ToggleSwitch({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle?: (next: boolean) => void;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked, disabled: !onToggle }}
      disabled={!onToggle}
      onPress={() => onToggle?.(!checked)}
      style={[styles.action, styles.header]}
    >
      <Text style={styles.heading}>{label}</Text>
      <View
        style={{
          width: 42,
          borderRadius: 12,
          padding: 3,
          flexDirection: "row",
          justifyContent: checked ? "flex-end" : "flex-start",
          backgroundColor: checked ? colors.accent : colors.muted,
        }}
      >
        <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: colors.surface }} />
      </View>
    </Pressable>
  );
}

export function ShareCard({ title, url }: { title: string; url?: string | undefined }) {
  return url ? (
    <Image
      accessibilityLabel={`LINE共有カード — ${title}`}
      source={{ uri: url }}
      resizeMode="contain"
      style={{ width: "100%", aspectRatio: 1200 / 630 }}
    />
  ) : (
    <View style={styles.lineCard}>
      <Text style={{ color: "#bbf7d0", fontWeight: "800" }}>LINE</Text>
      <Text style={[styles.title, { color: colors.surface }]}>{title}</Text>
      <Text style={{ color: colors.outline }}>3D動作レポート · 骨格の動きと試技の比較</Text>
    </View>
  );
}

export function VideoDropzone({ onSample }: { onSample?: () => void }) {
  return (
    <View style={styles.grid}>
      <View style={[styles.guide, { minHeight: 90 }]}>
        <Text style={styles.icon}>↑</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.heading}>動画の取り込み</Text>
          <Copy>ファイル選択とプレビューはブラウザー版で利用できます。</Copy>
        </View>
      </View>
      {onSample && <Action onPress={onSample}>サンプル試技ですぐ体験</Action>}
    </View>
  );
}

export function Link({ label, href }: { label: string; href: string }) {
  return (
    <Text accessibilityRole="link" onPress={() => void Linking.openURL(href)} style={styles.link}>
      {label}
    </Text>
  );
}

export function Scrubber({ label, value, onChange }: ScrubberProps) {
  const [width, setWidth] = useState(0);
  const seek = (next: number) => onChange(Math.max(0, Math.min(100, next)));
  return (
    <View>
      <Copy>{label}</Copy>
      <Pressable
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(value) }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={({ nativeEvent }) =>
          seek(value + (nativeEvent.actionName === "increment" ? 5 : -5))
        }
        onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
        onPress={({ nativeEvent }) => {
          if (width > 0) seek((nativeEvent.locationX / width) * 100);
        }}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <View
          pointerEvents="none"
          style={{ backgroundColor: colors.border, height: 8, borderRadius: 4 }}
        >
          <View
            style={{
              backgroundColor: colors.teal,
              width: `${value}%`,
              height: 8,
              borderRadius: 4,
            }}
          />
        </View>
      </Pressable>
    </View>
  );
}

export function Loupe({
  width,
  height,
  x,
  y,
  zoom,
  points,
  frameWidth,
  frameHeight,
  focusX,
  focusY,
}: LoupeProps) {
  const zoomed = points.map(({ id, left, top, ...style }) => ({
    id,
    x: (left / frameWidth) * 100,
    y: (top / frameWidth) * 100,
    ...style,
  }));
  const [size, setSize] = useState(0);
  return (
    <View
      onLayout={({ nativeEvent }) => setSize(nativeEvent.layout.width)}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`拡大ルーペ ${zoom}倍。表示位置 x ${x.toFixed(1)} y ${y.toFixed(1)} px`}
      style={{
        width: "100%",
        maxWidth: Math.min(340, (220 * frameWidth) / frameHeight),
        aspectRatio: frameWidth / frameHeight,
        backgroundColor: colors.canvas,
        borderRadius: 8,
      }}
    >
      <View
        style={{
          position: "absolute",
          left: `${(focusX / frameWidth) * 100}%`,
          top: `${(focusY / frameHeight) * 100}%`,
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: colors.teal,
          transform: [{ translateX: -4 }, { translateY: -4 }],
        }}
      />
      <View
        style={{
          position: "absolute",
          left: `${(x / frameWidth) * 100}%`,
          top: `${(y / frameHeight) * 100}%`,
          width: `${(width / frameWidth) * 100}%`,
          height: `${(height / frameHeight) * 100}%`,
          borderWidth: 1,
          borderColor: colors.accent,
          backgroundColor: colors.tint,
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {skeletonSegments(zoomed).map(({ id, a, b, color }) => {
          const dx = ((b.x - a.x) * size) / 100;
          const dy = ((b.y - a.y) * size) / 100;
          const length = Math.hypot(dx, dy);
          return (
            <View
              key={id}
              style={{
                position: "absolute",
                width: length,
                height: 3,
                backgroundColor: color,
                left: ((a.x + b.x) * size) / 200 - length / 2,
                top: ((a.y + b.y) * size) / 200 - 1.5,
                transform: [{ rotateZ: `${Math.atan2(dy, dx)}rad` }],
              }}
            />
          );
        })}
        {points.map(({ id, left, top, color }) => (
          <View
            key={id}
            style={{
              position: "absolute",
              left: `${(left / width) * 100}%`,
              top: `${(top / height) * 100}%`,
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: color ?? "#ccfbf1",
              transform: [{ translateX: -3 }, { translateY: -3 }],
            }}
          />
        ))}
      </View>
    </View>
  );
}
