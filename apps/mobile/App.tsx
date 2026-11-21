import { useAsyncStorage } from "@react-native-async-storage/async-storage";
import clone from "@ungap/structured-clone";
import { registerRootComponent } from "expo";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { EditingRecomputeResult } from "./src/editing-studio.js";
import { SportsMotionApp } from "./src/ui/App.js";
import { createDemo, createLiveDemo, readLiveDemoConfig } from "./src/ui/demo.js";
import type { CaptureQueueItem, CaptureSelection } from "./src/ui/screens/CaptureScreen.js";

const queueKey = "sports-motion-demo-capture-v1";

if (typeof globalThis.structuredClone !== "function") {
  globalThis.structuredClone = (value, options) => {
    if (options?.transfer?.length) throw new TypeError("Transfer is unavailable");
    return clone(value);
  };
}

function readQueueItem(value: unknown): CaptureQueueItem | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const { capture_id, movement, coordinateFrame, status } = record;
  if (
    typeof capture_id !== "string" ||
    capture_id.trim() === "" ||
    (movement !== "running" && movement !== "baseball_pitching" && movement !== "jump_landing") ||
    (coordinateFrame !== "HipRelative3D" && coordinateFrame !== "CalibratedWorld3D") ||
    (status !== "LocalCaptured" && status !== "QueuedOffline" && status !== "Uploaded")
  )
    return undefined;
  return { capture_id, movement, coordinateFrame, status };
}

export default function App() {
  const storage = useAsyncStorage(queueKey);
  const [getItem] = useState(() => storage.getItem);

  const [selection, setSelection] = useState<CaptureSelection>({
    movement: "running",
    coordinateFrame: "HipRelative3D",
  });
  const [queue, setQueue] = useState<CaptureQueueItem[]>([]);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const writing = useRef(false);
  const selectionCommitted = useRef(false);
  const [config, setConfig] = useState<ReturnType<typeof readLiveDemoConfig>>();
  const [recomputed, setRecomputed] = useState<EditingRecomputeResult>();
  const sample = useMemo(() => createDemo(selection.movement), [selection.movement]);
  const live = useMemo(() => config && createLiveDemo(config), [config]);
  const liveData = useMemo(
    () =>
      config && live && recomputed
        ? createLiveDemo(config, recomputed, live.editing.controller)
        : live,
    [config, live, recomputed],
  );
  const activeLive =
    selection.movement === "running" && selection.coordinateFrame === "CalibratedWorld3D"
      ? liveData
      : undefined;
  const demo = activeLive ?? sample;
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const request = new AbortController();
    const load = async () => {
      try {
        const response = await fetch("/demo-config.json", {
          cache: "no-store",
          signal: request.signal,
        });
        if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json"))
          return;
        const data = readLiveDemoConfig(await response.json());
        if (!data || request.signal.aborted) return;
        setConfig(data);
        if (!selectionCommitted.current)
          setSelection({ movement: "running", coordinateFrame: "CalibratedWorld3D" });
      } catch {
        // Standalone Expo builds use the bundled sample.
      }
    };
    void load();
    return () => request.abort();
  }, []);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const raw = await getItem();
        if (active && raw) {
          const stored: unknown = JSON.parse(raw);
          if (!Array.isArray(stored)) throw new TypeError("Invalid capture queue");
          setQueue(stored.map(readQueueItem).filter((item) => item !== undefined));
        }
      } catch {
        if (active) setStorageError(true);
      } finally {
        if (active) setReady(true);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [getItem]);
  const saveCapture = async () => {
    if (!ready || writing.current) return;
    selectionCommitted.current = true;
    const capture_id = `demo-${selection.movement}-${selection.coordinateFrame}`;
    if (queue.some((item) => item.capture_id === capture_id)) return;
    const next: CaptureQueueItem[] = [
      ...queue,
      { ...selection, capture_id, status: "LocalCaptured" },
    ];
    writing.current = true;
    try {
      await storage.setItem(JSON.stringify(next));
      setQueue(next);
      setStorageError(false);
    } catch {
      setStorageError(true);
    } finally {
      writing.current = false;
    }
  };
  return (
    <SafeAreaProvider>
      <SportsMotionApp
        {...demo}
        editing={activeLive ? { ...demo.editing, onRecomputed: setRecomputed } : demo.editing}
        {...(storageError && {
          notice: "デモデータを表示中。端末の撮影記録にアクセスできません。",
        })}
        capture={{
          selection,
          onSelect: (next) => {
            selectionCommitted.current = true;
            setSelection(next);
          },
          live: Boolean(activeLive),
          queue,
          loading: !ready,
          onSaveCapture: saveCapture,
        }}
      />
    </SafeAreaProvider>
  );
}

registerRootComponent(App);
