import { type ReactNode, useEffect, useRef, useState } from "react";
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
import { webStyles } from "./web-styles.js";

export { SkeletonCanvas2D, SkeletonPreview3D, TrendChart, WaveformChart } from "./visuals.js";

export function Page({ children, focusKey }: { children: ReactNode; focusKey?: string }) {
  const main = useRef<HTMLElement>(null);
  const previous = useRef(focusKey);
  useEffect(() => {
    if (previous.current === focusKey) return;
    previous.current = focusKey;
    main.current?.querySelector<HTMLVideoElement>("[hidden] video")?.pause();
    main.current?.querySelector<HTMLElement>("h1:not([hidden] h1)")?.focus({ preventScroll: true });
    main.current?.scrollIntoView({ block: "start" });
  }, [focusKey]);
  return (
    <main ref={main} lang="ja" className="sm">
      <style>{webStyles}</style>
      <div className="sm-shell">{children}</div>
    </main>
  );
}

export function Header({ children }: { children: ReactNode }) {
  return (
    <header className="sm-header">
      <div className="sm-brand">
        <div className="sm-brand-icon" aria-hidden="true">
          <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path
              d="M3 16h4l4-9 3 11 3-6h4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div>
          <strong>Sports Motion</strong>
          <small>3D動作解析・コーチング</small>
        </div>
      </div>
      <Row>{children}</Row>
    </header>
  );
}

export function Stepper({ steps, active, visited, onSelect }: StepperProps) {
  return (
    <nav aria-label="解析の進捗">
      <ol className="sm-steps">
        {steps.map((label, index) => (
          <li key={label}>
            <button
              type="button"
              className="sm-step"
              aria-current={index === active ? "step" : undefined}
              data-visited={visited.has(index)}
              onClick={() => onSelect(index)}
            >
              <span className="sm-step-number">
                {index !== active && visited.has(index) ? "✓" : index + 1}
              </span>
              <strong>{label}</strong>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="sm-panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function Title({ children, subtitle }: { children: string; subtitle?: string }) {
  return (
    <div className="sm-heading">
      <h1 tabIndex={-1}>{children}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="sm-row">{children}</div>;
}

export function Grid({
  children,
  layout,
}: {
  children: ReactNode;
  layout?: "split" | "equal" | "choices";
}) {
  return (
    <div className="sm-grid" data-layout={layout}>
      {children}
    </div>
  );
}

export function ViewSlot({ children, hidden }: { children: ReactNode; hidden: boolean }) {
  return (
    <div hidden={hidden} className={hidden ? undefined : "sm-grid"}>
      {children}
    </div>
  );
}

export function Copy({ children }: { children: ReactNode }) {
  return <p className="sm-copy">{children}</p>;
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
    <p
      className="sm-notice"
      data-tone={tone}
      role={nonDiagnostic ? "note" : "status"}
      data-non-diagnostic={nonDiagnostic ? "true" : undefined}
    >
      {children}
    </p>
  );
}

export function Action({
  children,
  onPress,
  selected,
  disabled,
  variant = "secondary",
}: ActionProps) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-pressed={selected}
      disabled={disabled}
      className="sm-action"
      data-variant={variant}
    >
      {children}
    </button>
  );
}

export function Footer({ onBack, children }: FooterProps) {
  return (
    <div className="sm-footer">
      {onBack && (
        <Action variant="ghost" onPress={onBack}>
          ← 戻る
        </Action>
      )}
      <div>{children}</div>
    </div>
  );
}

export function ChoiceCard({ label, description, icon, selected, onPress }: ChoiceCardProps) {
  return (
    <button type="button" aria-pressed={selected} onClick={onPress} className="sm-choice">
      <span aria-hidden="true" className="sm-choice-icon">
        {icon}
      </span>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </button>
  );
}

export function GuideBanner({ badge, children, tone = "default" }: GuideProps) {
  return (
    <aside className="sm-guide" data-tone={tone} aria-live="polite">
      <span className="sm-badge">{badge}</span>
      <div>
        <strong>次にやること</strong>
        <p>{children}</p>
      </div>
    </aside>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="sm-stats">{children}</div>;
}

export function StatCard({ label, value, unit, trend }: StatProps) {
  return (
    <div className="sm-stat">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{unit}</small>
      {trend && <em>{trend}</em>}
    </div>
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
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={!onToggle}
      onClick={() => onToggle?.(!checked)}
      className="sm-switch"
    >
      {label}
      <span aria-hidden="true" className="sm-switch-track" />
    </button>
  );
}

export function Link({ label, href }: { label: string; href: string }) {
  return (
    <a className="sm-link" href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

export function ShareCard({ title, url }: { title: string; url?: string | undefined }) {
  return url ? (
    <img className="sm-line-image" src={url} alt={`LINE共有カード — ${title}`} />
  ) : (
    <div className="sm-line-card">
      <span>LINE</span>
      <strong>{title}</strong>
      <small>3D動作レポート · 骨格の動きと試技の比較を確認できます。</small>
    </div>
  );
}

export function VideoDropzone({ onSample }: { onSample?: () => void }) {
  const [video, setVideo] = useState<{ url: string; name: string }>();
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  useEffect(
    () => () => {
      if (video) URL.revokeObjectURL(video.url);
    },
    [video],
  );
  function choose(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("video/") && !/\.(mp4|mov|webm)$/iu.test(file.name)) {
      setError("MP4、MOV、WebMなどの動画ファイルを選んでください。");
      return;
    }
    setError("");
    setVideo({ url: URL.createObjectURL(file), name: file.name });
  }
  return (
    <>
      <label
        className="sm-drop"
        data-dragging={dragging}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          choose(event.dataTransfer.files[0]);
        }}
      >
        <span className="sm-drop-icon" aria-hidden="true">
          <svg
            aria-hidden="true"
            width="19"
            height="19"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <path
              d="M12 16V4m-5 5 5-5 5 5M4 15v5h16v-5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <strong>{video ? "別の動画を選ぶ" : "動画ファイルを選ぶ"}</strong>
        <small>{video?.name ?? "ドラッグ＆ドロップ · MP4 / MOV / WebM"}</small>
        <input
          className="sm-file"
          type="file"
          accept="video/*"
          onChange={(event) => {
            choose(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
      </label>
      {video && (
        <video
          key={video.url}
          className="sm-video"
          src={video.url}
          controls
          playsInline
          aria-label={`動画プレビュー ${video.name}`}
          onError={() => setError("この動画形式はお使いのブラウザーで再生できません。")}
        >
          <track kind="captions" />
        </video>
      )}
      {error && <Notice>{error}</Notice>}
      {onSample && (
        <Action
          variant="secondary"
          onPress={() => {
            setVideo(undefined);
            setError("");
            onSample();
          }}
        >
          サンプル試技ですぐ体験
        </Action>
      )}
    </>
  );
}

export function Scrubber({ label, value, onChange }: ScrubberProps) {
  return (
    <label className="sm-scrubber">
      {label}
      <input
        type="range"
        min={0}
        max={100}
        step={0.1}
        value={value}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
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
    <svg
      role="img"
      aria-label={`拡大ルーペ ${zoom}倍。表示位置 x ${x.toFixed(1)} y ${y.toFixed(1)} px`}
      data-loupe-x={x}
      data-loupe-y={y}
      viewBox={`0 0 ${frameWidth} ${frameHeight}`}
      style={{ width: "100%", height: "auto", background: colors.dark, borderRadius: 12 }}
    >
      <path
        d={`M0 ${focusY}H${frameWidth} M${focusX} 0V${frameHeight}`}
        stroke="#334155"
        strokeDasharray="4 4"
      />
      <path
        d={`M${focusX} ${focusY}L${x + width / 2} ${y + height / 2}`}
        stroke="#99f6e4"
        strokeWidth="1"
      />
      <circle cx={focusX} cy={focusY} r="6" fill="none" stroke="#5eead4" strokeWidth="1.5" />
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={colors.darkRaised}
        stroke="#5eead4"
        rx="7"
      />
      <svg
        x={x}
        y={y}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
      >
        {skeletonSegments(
          points.map(({ id, left, top, ...style }) => ({ id, x: left, y: top, ...style })),
        ).map(({ id, a, b, color }) => (
          <line
            key={id}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={color}
            strokeWidth="4"
            strokeDasharray={color === "#fb7185" ? "5 5" : undefined}
          />
        ))}
        {points.map(({ id, left, top, color }) => (
          <circle
            key={id}
            cx={left}
            cy={top}
            r={color ? 7 : 4}
            fill={color ?? "#ccfbf1"}
            stroke={colors.dark}
            strokeWidth="1"
          />
        ))}
      </svg>
    </svg>
  );
}
