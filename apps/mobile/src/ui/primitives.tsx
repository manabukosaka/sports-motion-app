import type { CSSProperties, ReactNode } from "react";
import { colors } from "./theme.js";

export interface ActionProps {
  children: string;
  onPress: () => void;
  selected?: boolean;
  disabled?: boolean;
}

export interface ScrubberProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
}

export interface LoupeProps {
  width: number;
  height: number;
  x: number;
  y: number;
  zoom: number;
  frameWidth: number;
  frameHeight: number;
  focusX: number;
  focusY: number;
  points: readonly { id: string; left: number; top: number }[];
}

const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: 12 };

export function Page({ children }: { children: ReactNode }) {
  return (
    <main
      lang="ja"
      style={{
        background: colors.canvas,
        color: colors.ink,
        minHeight: "100vh",
        padding: "24px 16px",
        boxSizing: "border-box",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div style={{ ...stack, maxWidth: 720, margin: "0 auto" }}>{children}</div>
    </main>
  );
}

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      style={{
        ...stack,
        border: `1px solid ${colors.border}`,
        borderRadius: 16,
        background: colors.surface,
        padding: 16,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 19 }}>{title}</h2>
      {children}
    </section>
  );
}

export function Title({ children }: { children: string }) {
  return <h1 style={{ margin: 0, fontSize: 30, letterSpacing: -0.8 }}>{children}</h1>;
}

export function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{children}</div>;
}

export function Copy({ children }: { children: ReactNode }) {
  return <p style={{ margin: 0, lineHeight: 1.5, overflowWrap: "anywhere" }}>{children}</p>;
}

export function Notice({
  children,
  nonDiagnostic = false,
}: {
  children: string;
  nonDiagnostic?: boolean;
}) {
  return (
    <p
      role={nonDiagnostic ? "note" : "status"}
      data-non-diagnostic={nonDiagnostic ? "true" : undefined}
      style={{
        margin: 0,
        padding: "10px 12px",
        borderRadius: 8,
        background: colors.warningSurface,
        color: colors.warning,
      }}
    >
      {children}
    </p>
  );
}

export function Action({ children, onPress, selected, disabled }: ActionProps) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-pressed={selected}
      disabled={disabled}
      style={{
        background: selected ? colors.accent : colors.tint,
        color: selected ? colors.surface : colors.accent,
        border: 0,
        borderRadius: 8,
        minHeight: 44,
        padding: "8px 12px",
        font: "inherit",
        fontWeight: 600,
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

export function Link({ label, href }: { label: string; href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ color: colors.accent }}>
      {label}
    </a>
  );
}

export function Scrubber({ label, value, onChange }: ScrubberProps) {
  return (
    <label style={stack}>
      {label}
      <input
        type="range"
        min={0}
        max={100}
        step={0.1}
        value={value}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
        style={{ accentColor: colors.accent }}
      />
    </label>
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
    <div
      role="img"
      aria-label={`拡大ルーペ ${zoom}倍。表示位置 x ${x.toFixed(1)} y ${y.toFixed(1)} px`}
      data-loupe-x={x}
      data-loupe-y={y}
      style={{
        position: "relative",
        width: "100%",
        maxWidth: Math.min(340, (220 * frameWidth) / frameHeight),
        aspectRatio: frameWidth / frameHeight,
        background: colors.canvas,
        borderRadius: 8,
      }}
    >
      <span
        style={{
          position: "absolute",
          left: `${(focusX / frameWidth) * 100}%`,
          top: `${(focusY / frameHeight) * 100}%`,
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: colors.accent,
          transform: "translate(-50%, -50%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: `${(x / frameWidth) * 100}%`,
          top: `${(y / frameHeight) * 100}%`,
          width: `${(width / frameWidth) * 100}%`,
          height: `${(height / frameHeight) * 100}%`,
          boxSizing: "border-box",
          border: `1px solid ${colors.accent}`,
          background: colors.tint,
          borderRadius: 8,
        }}
      >
        {points.map(({ id, left, top }) => (
          <span
            key={id}
            style={{
              position: "absolute",
              left: `${(left / width) * 100}%`,
              top: `${(top / height) * 100}%`,
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: colors.accent,
              transform: "translate(-50%, -50%)",
            }}
          />
        ))}
      </div>
    </div>
  );
}
