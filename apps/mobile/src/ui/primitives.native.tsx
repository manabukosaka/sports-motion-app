import type { ReactNode } from "react";
import { useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ActionProps, LoupeProps, ScrubberProps } from "./primitives.js";
import { colors } from "./theme.js";

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.canvas },
  content: { padding: 16, gap: 12 },
  panel: {
    padding: 16,
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  title: { fontSize: 30, fontWeight: "700", color: colors.ink },
  heading: { fontSize: 19, fontWeight: "700", color: colors.ink },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  copy: { color: colors.ink, fontSize: 16, lineHeight: 24 },
  notice: { padding: 10, borderRadius: 8, backgroundColor: colors.warningSurface },
  action: {
    backgroundColor: colors.tint,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 44,
    justifyContent: "center",
  },
  actionLabel: { fontWeight: "600", fontSize: 16, color: colors.accent },
  link: { color: colors.accent, textDecorationLine: "underline", fontSize: 16 },
});

export function Page({ children }: { children: ReactNode }) {
  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.content}>{children}</ScrollView>
    </SafeAreaView>
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

export function Title({ children }: { children: string }) {
  return (
    <Text accessibilityRole="header" style={styles.title}>
      {children}
    </Text>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

export function Copy({ children }: { children: ReactNode }) {
  return <Text style={styles.copy}>{children}</Text>;
}

export function Notice({
  children,
  nonDiagnostic = false,
}: {
  children: string;
  nonDiagnostic?: boolean;
}) {
  return (
    <View
      accessibilityLiveRegion={nonDiagnostic ? "none" : "polite"}
      testID={nonDiagnostic ? "non-diagnostic" : "status"}
      style={styles.notice}
    >
      <Text style={[styles.copy, { color: colors.warning }]}>{children}</Text>
    </View>
  );
}

export function Action({ children, onPress, selected, disabled = false }: ActionProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, ...(selected !== undefined && { selected }) }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.action,
        selected && { backgroundColor: colors.accent },
        disabled && { opacity: 0.55 },
      ]}
    >
      <Text style={[styles.actionLabel, selected && { color: colors.surface }]}>{children}</Text>
    </Pressable>
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
              backgroundColor: colors.accent,
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
  return (
    <View
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
          backgroundColor: colors.accent,
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
        }}
      >
        {points.map(({ id, left, top }) => (
          <View
            key={id}
            style={{
              position: "absolute",
              left: `${(left / width) * 100}%`,
              top: `${(top / height) * 100}%`,
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: colors.accent,
              transform: [{ translateX: -3 }, { translateY: -3 }],
            }}
          />
        ))}
      </View>
    </View>
  );
}
