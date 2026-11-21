import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  type Capture,
  CaptureQueue,
  type CaptureQueueState,
  emptyCaptureQueue,
  FileStateStore,
  LifecycleConflict,
  LifecycleEngine,
  type LifecycleState,
  MemoryStateStore,
} from "../src/index.js";

const limits = {
  uploadDeadlineTicks: 2,
  queueDeadlineTicks: 2,
  execDeadlineTicks: 2,
  maxAttempts: 2,
};
const settings = {
  calibrationId: "none",
  pipelineVersion: "1.0.0",
  modelHash: "none",
  filterSpec: { version: "1.0.0", cutoffHz: 6 },
};
const raw = Uint8Array.of(13, 0, 255);
const rawBase64 = Buffer.from(raw).toString("base64");
type Property = "S1" | "S2" | "S3" | "S4" | "L1";
type Step<E> = { property: Property; event: E };
type Trace<E> = { tick: number; event: E; previous?: Trace<E> };
type Check = (property: Property, condition: () => void) => void;

function counterexample<E>(property: Property, trace: Trace<E> | undefined, error: unknown) {
  const events: { tick: number; event: E }[] = [];
  for (let step = trace; step; step = step.previous) {
    events.push({ tick: step.tick, event: step.event });
  }
  return new Error(JSON.stringify({ property, events: events.reverse(), error: String(error) }), {
    cause: error,
  });
}

function explore<Model extends { tick: number }, Actual, Event>(
  name: string,
  initial: { model: Model; actual: Actual },
  enabled: (model: Model) => Step<Event>[],
  replay: (model: Model, actual: Actual, event: Event, check: Check) => Actual,
  verify: (model: Model, actual: Actual, check: Check) => number,
  bound: number,
  stateKey: (model: Model) => string = JSON.stringify,
) {
  const frontier: { model: Model; actual: Actual; trace?: Trace<Event> }[] = [initial];
  const visited = new Set([stateKey(initial.model)]);
  let transitionCount = 0;
  let maxTicks = 0;
  const checks =
    (trace?: Trace<Event>): Check =>
    (property, condition) => {
      try {
        condition();
      } catch (error) {
        throw counterexample(property, trace, error);
      }
    };
  verify(initial.model, initial.actual, checks());
  for (const node of frontier) {
    for (const { property, event } of enabled(node.model)) {
      const model = structuredClone(node.model);
      const trace: Trace<Event> = {
        tick: node.model.tick,
        event,
        ...(node.trace && { previous: node.trace }),
      };
      const check = checks(trace);
      const actual = (() => {
        try {
          return replay(model, node.actual, event, check);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('{"property":')) {
            throw error;
          }
          throw counterexample(property, trace, error);
        }
      })();
      trace.tick = model.tick;
      const elapsed = verify(model, actual, check);
      check("L1", () => assert.ok(elapsed <= bound, `Exceeded ${bound} ticks: ${elapsed}`));
      maxTicks = Math.max(maxTicks, elapsed);
      transitionCount++;
      const key = stateKey(model);
      if (!visited.has(key)) {
        visited.add(key);
        frontier.push({ model, actual, trace });
      }
    }
  }
  checks()("L1", () => {
    assert.ok(frontier.length > 1 && transitionCount >= frontier.length - 1 && maxTicks <= bound);
  });
  console.log(
    `${name}: ${frontier.length} reachable states, ${transitionCount} transitions, max ${maxTicks}/${bound} L1 ticks`,
  );
  return visited;
}

const keys = ["c1", "c2"] as const;
type CaptureId = (typeof keys)[number];
type Upload = {
  status: "absent" | "local" | "queued" | "uploading" | "retryable" | "terminal" | "uploaded";
  attempts: number;
  start: number;
  retryAt: number;
  server: boolean;
  removed: boolean;
  age: number;
  sentVersion: "1.0.0" | "1.1.0";
};
type CaptureModel = { tick: number; version: "1.0.0" | "1.1.0"; items: Record<CaptureId, Upload> };
type CaptureEvent =
  | {
      action:
        | "record"
        | "enqueue"
        | "start"
        | "offline"
        | "update-required"
        | "send"
        | "ack"
        | "bad-ack"
        | "remove"
        | "conflict"
        | "permanent"
        | "fail";
      key: CaptureId;
    }
  | { action: "restart" | "migrate" | "tick"; key?: never };
type CaptureActual = { queue: CaptureQueueState; server: LifecycleState };

function capture(key: CaptureId, version = "1.0.0"): Capture {
  return {
    teamId: "a",
    captureId: key,
    video: Uint8Array.of(key === "c1" ? 1 : 2),
    contractVersion: version,
  };
}

function captureEvents(model: CaptureModel): Step<CaptureEvent>[] {
  const events: Step<CaptureEvent>[] = [];
  if (model.tick < 5) {
    events.push({ property: "L1", event: { action: "tick" } });
  }
  if (model.version === "1.0.0") {
    events.push({ property: "S1", event: { action: "migrate" } });
  }
  events.push({ property: "S1", event: { action: "restart" } });
  for (const key of keys) {
    const item = model.items[key];
    const add = (property: Property, action: CaptureEvent["action"]) => {
      if (action !== "tick" && action !== "migrate" && action !== "restart") {
        events.push({ property, event: { action, key } });
      }
    };
    if (item.status === "absent") {
      add("S1", "record");
      continue;
    }
    if (item.status === "local") {
      add("S1", "enqueue");
    }
    add("S1", "remove");
    if (item.status === "queued" || item.status === "retryable") {
      add("S1", "offline");
      add("S1", "update-required");
      if (model.tick <= 3 && model.tick >= item.retryAt) {
        add("L1", "start");
      }
    }
    if (item.status === "uploading") {
      add("S4", "send");
      add("L1", "fail");
      add("L1", "permanent");
    }
    if (item.server) {
      add("S4", "send");
      add("S4", "conflict");
      add("S1", "ack");
      add("S1", "bad-ack");
    }
  }
  return events;
}

function captureFailure(item: Upload, tick: number) {
  item.status = item.attempts === 2 ? "terminal" : "retryable";
  item.retryAt = tick + 1;
  item.age = tick - item.start;
}

function captureStateKey(model: CaptureModel) {
  const normalize = (item: Upload) => ({
    ...item,
    start: item.status === "uploading" ? item.start : 0,
    retryAt:
      (item.status === "queued" || item.status === "retryable") && item.retryAt > model.tick
        ? item.retryAt
        : 0,
    age: 0,
  });
  return JSON.stringify({
    ...model,
    items: { c1: normalize(model.items.c1), c2: normalize(model.items.c2) },
  });
}

function replayCapture(
  model: CaptureModel,
  actual: CaptureActual,
  event: CaptureEvent,
  check: Check,
): CaptureActual {
  const store = new MemoryStateStore(actual.queue);
  let queue = new CaptureQueue(limits, store);
  const server = new LifecycleEngine(limits, settings, new MemoryStateStore(actual.server));
  const { action, key } = event;
  if (key === undefined) {
    if (action === "tick") {
      model.tick++;
      queue.advanceTo(model.tick);
      server.advanceTo(model.tick);
      for (const item of Object.values(model.items)) {
        if (item.status === "uploading" && model.tick === item.start + 2) {
          captureFailure(item, model.tick);
        }
      }
    } else if (action === "restart") {
      queue = new CaptureQueue(limits, store);
      queue.recover();
      for (const item of Object.values(model.items)) {
        if (item.status === "local") {
          item.status = "queued";
        } else if (item.status === "uploading") {
          captureFailure(item, model.tick);
        }
      }
    } else {
      model.version = "1.1.0";
      queue.migrate(model.version);
    }
  } else {
    const item = model.items[key];
    const trial = actual.server.trials.find((trial) => trial.ack.captureId === key);
    switch (action) {
      case "record":
        item.status = "local";
        item.sentVersion = model.version;
        queue.record(capture(key, model.version));
        break;
      case "enqueue":
        assert.equal(queue.enqueue("a", key), true);
        item.status = "queued";
        break;
      case "start": {
        item.status = "uploading";
        item.start = model.tick;
        item.age = 0;
        item.attempts++;
        item.sentVersion = model.version;
        const started = queue.start("a", key, true, [model.version]);
        check("S1", () => {
          assert.equal(started?.attemptNo, item.attempts);
          assert.equal(started?.capture.captureId, key);
          assert.equal(started?.capture.contractVersion, model.version);
          assert.deepEqual(
            Buffer.from(started?.capture.video ?? []),
            Buffer.from(capture(key).video),
          );
        });
        break;
      }
      case "offline":
      case "update-required":
        if (model.tick >= item.retryAt) {
          item.status = "queued";
        }
        assert.equal(
          queue.start(
            "a",
            key,
            action !== "offline",
            action === "update-required" ? [] : [model.version],
          ),
          undefined,
        );
        break;
      case "send": {
        const ack = server.submitCapture(capture(key, item.sentVersion));
        if (trial) {
          assert.deepEqual(ack, trial.ack);
        }
        item.server = true;
        break;
      }
      case "ack":
        assert.ok(trial && queue.acknowledge("a", key, trial.ack));
        if (item.status === "uploading") {
          item.age = model.tick - item.start;
        }
        item.status = "uploaded";
        break;
      case "bad-ack":
        assert.ok(trial);
        for (const wrong of [
          { teamId: "b" },
          { captureId: key === "c1" ? "c2" : "c1" },
          { trialId: "different" },
        ]) {
          assert.equal(queue.acknowledge("a", key, { ...trial.ack, ...wrong }), false);
        }
        break;
      case "remove":
        assert.equal(queue.remove("a", key), item.status === "uploaded");
        item.removed ||= item.status === "uploaded";
        break;
      case "fail":
      case "permanent":
        queue.fail("a", key, item.attempts, action === "permanent");
        captureFailure(item, model.tick);
        if (action === "permanent") {
          item.status = "terminal";
        }
        break;
      case "conflict":
        assert.throws(
          () => server.submitCapture({ ...capture(key, model.version), video: Uint8Array.of(99) }),
          { reason: "capture_id" },
        );
        break;
    }
  }
  return { queue: queue.snapshot(), server: server.snapshot() };
}

const uploadStates = {
  local: "LocalCaptured",
  queued: "QueuedOffline",
  uploading: "Uploading",
  retryable: "FailedRetryable",
  terminal: "FailedTerminal",
  uploaded: "Uploaded",
};

function verifyCapture(model: CaptureModel, actual: CaptureActual, check: Check) {
  let max = 0;
  for (const key of keys) {
    const item = model.items[key];
    const stored = actual.queue.captures.find((capture) => capture.captureId === key);
    const trials = actual.server.trials.filter((trial) => trial.ack.captureId === key);
    check("S4", () => {
      assert.equal(trials.length, Number(item.server));
      assert.equal(
        actual.server.jobs.filter((job) => job.inputs.trialId === trials[0]?.ack.trialId).length,
        Number(item.server),
      );
    });
    check("S1", () => {
      assert.equal(actual.queue.tick, model.tick);
      assert.equal(Boolean(stored), item.status !== "absent");
      if (trials[0]) {
        assert.equal(trials[0].videoBase64, Buffer.from(capture(key).video).toString("base64"));
      }
      if (stored && item.status !== "absent") {
        assert.equal(stored.status, uploadStates[item.status]);
        assert.equal(stored.queued, item.status !== "local" && !item.removed);
        assert.equal(stored.videoBase64, Buffer.from(capture(key).video).toString("base64"));
        assert.deepEqual(stored.ack, item.status === "uploaded" ? trials[0]?.ack : undefined);
      }
    });
    check("L1", () => {
      assert.equal(stored?.attemptNo ?? 0, item.attempts);
      if (item.status === "uploading") {
        assert.ok(
          model.tick < item.start + 2 && model.tick < 5,
          "active upload needs a clock successor",
        );
      }
    });
    max = Math.max(max, item.status === "uploading" ? model.tick - item.start : item.age);
  }
  return max;
}

test("S1/S4/L1 exhaustively replay two offline capture queues against the capture service", () => {
  const upload: Upload = {
    status: "absent",
    attempts: 0,
    start: 0,
    retryAt: 0,
    server: false,
    removed: false,
    age: 0,
    sentVersion: "1.0.0",
  };
  const visited = explore<CaptureModel, CaptureActual, CaptureEvent>(
    "Capture S1/S4/L1",
    {
      model: { tick: 0, version: "1.0.0", items: { c1: upload, c2: { ...upload } } },
      actual: {
        queue: { tick: 0, captures: [] },
        server: { tick: 0, trials: [], jobs: [], analyses: [] },
      },
    },
    captureEvents,
    replayCapture,
    verifyCapture,
    limits.uploadDeadlineTicks + 1,
    captureStateKey,
  );
  const models = [...visited].map((key) => JSON.parse(key) as CaptureModel);
  checksForCoverage(
    "S1",
    models.some(
      (model) =>
        model.items.c1.removed &&
        model.items.c1.attempts === 2 &&
        model.items.c2.server &&
        model.items.c1.sentVersion === "1.1.0",
    ),
  );
}, 60000);

function checksForCoverage(property: Property, covered: unknown) {
  if (!covered) {
    throw counterexample(property, undefined, "Required state is unreachable");
  }
}

type JobPhase = "queued" | "running" | "published" | "retryable" | "terminal";
type ModeledAttempt = {
  phase: JobPhase;
  entered: number;
  origin: number;
  failure?: "expired" | "superseded" | "transient" | "permanent";
};
type JobModel = {
  tick: number;
  attempts: ModeledAttempt[];
  publishedBy: number | null;
  age: number;
  lateCompletion: boolean;
};
type JobEvent =
  | { action: "tick" | "claim" | "retry" | "duplicate" }
  | { action: "complete" | "fail" | "permanent"; attempt: number };

function attemptAt(model: JobModel) {
  const attempt = model.attempts.at(-1);
  assert.ok(attempt);
  return attempt;
}

function jobEvents(model: JobModel): Step<JobEvent>[] {
  const active = attemptAt(model);
  const events: Step<JobEvent>[] = [{ property: "S4", event: { action: "duplicate" } }];
  if (model.tick < 8) {
    events.push({ property: "L1", event: { action: "tick" } });
  }
  if (active.phase === "queued") {
    events.push({ property: "L1", event: { action: "claim" } });
  }
  if (model.attempts.length === 1 && model.tick <= 4) {
    events.push({ property: "S4", event: { action: "retry" } });
  }
  for (const [index, attempt] of model.attempts.entries()) {
    events.push({ property: "S3", event: { action: "complete", attempt: index + 1 } });
    if (attempt.phase === "running") {
      events.push(
        { property: "L1", event: { action: "fail", attempt: index + 1 } },
        { property: "L1", event: { action: "permanent", attempt: index + 1 } },
      );
    }
  }
  return events;
}

function replayJob(model: JobModel, actual: LifecycleState, event: JobEvent) {
  const engine = new LifecycleEngine(limits, settings, new MemoryStateStore(actual));
  const job = actual.jobs[0];
  assert.ok(job);
  const active = attemptAt(model);
  const attempt = model.attempts.length;
  switch (event.action) {
    case "tick":
      model.tick++;
      engine.advanceTo(model.tick);
      if (["queued", "running"].includes(active.phase) && model.tick === active.entered + 2) {
        active.phase = attempt === 1 ? "retryable" : "terminal";
        active.failure = "expired";
        active.entered = model.tick;
        model.age = model.tick - active.origin;
      }
      break;
    case "claim": {
      const claimed = engine.claim(job.id);
      assert.equal(claimed?.source.kind, "video");
      assert.deepEqual(claimed?.inputs, job.inputs);
      assert.equal(claimed?.attemptNo, attempt);
      active.phase = "running";
      active.entered = model.tick;
      break;
    }
    case "retry": {
      const retry =
        (active.phase === "retryable" || active.failure === "expired") &&
        model.tick > active.entered;
      assert.equal(engine.retry(job.id), retry);
      if (retry) {
        active.phase = "terminal";
        model.attempts.push({ phase: "queued", entered: model.tick, origin: model.tick });
      }
      break;
    }
    case "duplicate":
      assert.equal(
        engine.requestAnalysis(job.inputs.trialId, {
          ...settings,
          filterSpec: { cutoffHz: 6, version: "1.0.0" },
        }).id,
        job.id,
      );
      break;
    case "complete": {
      const result = engine.complete(
        job.id,
        event.attempt,
        { value: model.publishedBy === null ? 1 : 2 },
        raw,
      );
      if (attempt === event.attempt && active.phase === "running") {
        assert.ok(result);
        active.phase = "published";
        model.publishedBy = attempt;
        model.age = model.tick - active.origin;
      } else if (model.publishedBy === event.attempt) {
        assert.deepEqual(result?.result, { value: 1 });
      } else {
        assert.equal(result, undefined);
        const expired = model.attempts[event.attempt - 1];
        if (expired?.failure === "expired") {
          expired.phase = "terminal";
          model.lateCompletion ||= event.attempt < attempt;
        }
      }
      break;
    }
    case "fail":
    case "permanent":
      engine.fail(job.id, event.attempt, event.action === "permanent");
      active.phase = event.action === "permanent" || attempt === 2 ? "terminal" : "retryable";
      active.failure = event.action === "permanent" ? "permanent" : "transient";
      active.entered = model.tick;
      model.age = model.tick - active.origin;
      break;
  }
  return engine.snapshot();
}

const jobStates = {
  queued: "AnalysisQueued",
  running: "Analyzing",
  published: "Analyzed",
  retryable: "FailedRetryable",
  terminal: "FailedTerminal",
};

function verifyJob(model: JobModel, actual: LifecycleState, check: Check) {
  const job = actual.jobs[0];
  const active = attemptAt(model);
  const inProgress = active.phase === "queued" || active.phase === "running";
  check("L1", () => {
    assert.equal(actual.tick, model.tick);
    const logicalStatus =
      active.failure === "expired" && model.attempts.length === 1
        ? "FailedRetryable"
        : jobStates[active.phase];
    assert.equal(job?.status, logicalStatus);
    assert.deepEqual(
      job?.attempts.map((attempt) => [attempt.status, attempt.failure]),
      model.attempts.map((attempt) => [jobStates[attempt.phase], attempt.failure]),
    );
    assert.ok(
      !inProgress || (model.tick < active.entered + 2 && model.tick < 8),
      "active job needs a clock successor",
    );
  });
  check("S3", () => {
    const trial = actual.trials[0];
    assert.ok(trial);
    const engine = new LifecycleEngine(limits, settings, new MemoryStateStore(actual));
    const current = engine.currentAnalysis(trial.ack.trialId);
    assert.equal(Boolean(current), model.publishedBy !== null);
    if (current) {
      assert.equal(current.inputs.coordinateRevisionId, null);
      assert.equal(current.jobId, job?.id);
    }
  });
  check("S4", () => {
    assert.equal(actual.jobs.length, 1);
    assert.equal(actual.analyses.length, Number(model.publishedBy !== null));
    assert.deepEqual(
      job?.attempts.map((attempt) => attempt.attemptNo),
      model.attempts.map((_, index) => index + 1),
    );
  });
  return Math.max(model.age, inProgress ? model.tick - active.origin : 0);
}

test("S3/S4/L1 exhaustively replay queue and worker deadlines, retries and late completions", () => {
  const engine = new LifecycleEngine(limits, settings);
  engine.submitCapture(capture("c1"));
  const visited = explore(
    "Analysis S3/S4/L1",
    {
      model: {
        tick: 0,
        attempts: [{ phase: "queued", entered: 0, origin: 0 }],
        publishedBy: null,
        age: 0,
        lateCompletion: false,
      } as JobModel,
      actual: engine.snapshot(),
    },
    jobEvents,
    replayJob,
    verifyJob,
    limits.queueDeadlineTicks + limits.execDeadlineTicks + 1,
  );
  checksForCoverage(
    "L1",
    [...visited].some((key) => {
      const model = JSON.parse(key) as JobModel;
      return (
        model.publishedBy === 2 &&
        model.lateCompletion &&
        model.attempts[0]?.phase === "terminal" &&
        model.attempts[0].failure === "expired"
      );
    }),
  );
});

type Editor = "e1" | "e2";
type Operation = "edit" | "undo" | "redo";
type RevisionStep = { id: string; operation: Operation; value: number; from: string[] };
const revisions: RevisionStep[] = [
  { id: "r1", operation: "edit", value: 11, from: [""] },
  { id: "r2", operation: "edit", value: 22, from: ["r1"] },
  { id: "r3", operation: "undo", value: 11, from: ["r2"] },
  { id: "r4", operation: "redo", value: 22, from: ["r3"] },
  { id: "r5", operation: "edit", value: 33, from: ["r3"] },
];
type Recalc = {
  phase: "queued" | "running" | "expired" | "late-expired" | "superseded" | "published";
  entered: number;
};
type EditModel = {
  tick: number;
  revisions: { id: string; value: number }[];
  sessions: Partial<Record<Editor, string>>;
  jobs: Record<string, Recalc>;
};
type EditEvent =
  | { action: "open" | "discard" | "blocked-redo"; editor: Editor }
  | { action: "commit" | "replay" | "collision"; editor: Editor; revision: RevisionStep }
  | { action: "claim" | "complete" | "expire"; id: string };

const editors = ["e1", "e2"] as const;

function editHead(model: EditModel) {
  return model.revisions.at(-1)?.id ?? "";
}

function editStateKey(model: EditModel) {
  const head = editHead(model);
  const jobs = Object.entries(model.jobs).map(([id, job]) => [
    id,
    {
      ...job,
      entered: id === head ? job.entered : 0,
    },
  ]);
  return JSON.stringify({
    ...model,
    sessions: editors.map((editor) => model.sessions[editor]),
    jobs,
  });
}

function editEvents(model: EditModel): Step<EditEvent>[] {
  const head = editHead(model);
  const events: Step<EditEvent>[] = [];
  for (const editor of editors) {
    if (model.sessions[editor] === undefined) {
      events.push({ property: "S2", event: { action: "open", editor } });
    } else {
      events.push({ property: "S2", event: { action: "discard", editor } });
      for (const revision of revisions.filter((revision) => revision.from.includes(head))) {
        if (model.sessions[editor] !== "" || revision.operation === "edit") {
          events.push({ property: "S3", event: { action: "commit", editor, revision } });
        }
      }
      if (head === "r5" && model.sessions[editor] === head) {
        events.push({ property: "S2", event: { action: "blocked-redo", editor } });
      }
    }
  }
  for (const saved of model.revisions) {
    const revision = revisions.find((revision) => revision.id === saved.id);
    assert.ok(revision);
    for (const action of ["replay", "collision"] as const) {
      events.push({ property: "S4", event: { action, editor: "e1", revision } });
    }
  }
  for (const [id, job] of Object.entries(model.jobs)) {
    if (job.phase === "queued") {
      events.push({ property: "L1", event: { action: "claim", id } });
    }
    if (job.phase === "queued" || job.phase === "running") {
      events.push({ property: "L1", event: { action: "expire", id } });
    }
    events.push({ property: "S3", event: { action: "complete", id } });
  }
  return events;
}

function coordinateOperation(
  id: string,
  parent: string | null,
  operation: Operation,
  value: number,
) {
  return {
    contract_version: "1.0.0",
    revision_id: id,
    expected_head: parent,
    parent_revision_id: parent,
    operation,
    edits:
      operation === "edit"
        ? [
            {
              view_id: "side",
              frame_index: 0,
              landmark: {
                landmark_id: "knee",
                x: value,
                y: 2,
                confidence: null,
                missing_reason: null,
                source: "manual_edit",
              },
            },
          ]
        : [],
  };
}

function replayEdit(model: EditModel, actual: LifecycleState, event: EditEvent, check: Check) {
  const engine = new LifecycleEngine(limits, settings, new MemoryStateStore(actual));
  const trial = actual.trials[0];
  assert.ok(trial);
  const trialId = trial.ack.trialId;
  const head = editHead(model);
  switch (event.action) {
    case "open":
      assert.equal(engine.beginEdit(trialId, event.editor).expectedHead, head || null);
      model.sessions[event.editor] = head;
      break;
    case "discard":
      engine.discardEdit(trialId, event.editor);
      delete model.sessions[event.editor];
      break;
    case "commit": {
      const { revision, editor } = event;
      const operation = coordinateOperation(
        revision.id,
        model.sessions[editor] || null,
        revision.operation,
        revision.value,
      );
      if (model.sessions[editor] !== head) {
        assert.throws(() => engine.commitRevision(trialId, editor, operation), {
          reason: "head",
          currentHead: head,
        });
        break;
      }
      const previous = model.jobs[head];
      if (previous && previous.phase !== "published") {
        previous.phase = "superseded";
      }
      model.jobs[revision.id] = { phase: "queued", entered: model.tick };
      model.revisions.push({ id: revision.id, value: revision.value });
      delete model.sessions[editor];
      assert.equal(
        engine.commitRevision(trialId, editor, operation).version,
        model.revisions.length,
      );
      break;
    }
    case "replay":
    case "collision": {
      const old = trial.revisions.find(
        (record) => record.operation.revision_id === event.revision.id,
      );
      assert.ok(old);
      if (event.action === "replay") {
        assert.deepEqual(engine.commitRevision(trialId, event.editor, { ...old.operation }), old);
      } else {
        const conflicting = coordinateOperation(
          old.operation.revision_id,
          "different-expected-head",
          "edit",
          99,
        );
        assert.throws(() => engine.commitRevision(trialId, event.editor, conflicting), {
          reason: "revision_id",
        });
      }
      break;
    }
    case "blocked-redo":
      assert.throws(
        () =>
          engine.commitRevision(trialId, event.editor, coordinateOperation("r6", head, "redo", 22)),
        { reason: "history" },
      );
      break;
    case "claim":
    case "complete":
    case "expire": {
      const recalc = model.jobs[event.id];
      const jobId = trial.revisions.find(
        (record) => record.operation.revision_id === event.id,
      )?.jobId;
      assert.ok(recalc && jobId);
      if (event.action === "claim") {
        const claimed = engine.claim(jobId);
        check("S2", () =>
          assert.deepEqual(claimed?.source, {
            kind: "raw",
            rawBase64,
            edits: trial.revisions.at(-1)?.effectiveEdits,
          }),
        );
        assert.equal(claimed?.inputs.coordinateRevisionId, event.id);
        recalc.phase = "running";
        recalc.entered = model.tick;
      } else if (event.action === "expire") {
        model.tick += 2;
        engine.advanceTo(model.tick);
        recalc.phase = "expired";
      } else {
        const result = engine.complete(jobId, 1, { revision: event.id }, Uint8Array.of(0));
        if (recalc.phase === "running" || recalc.phase === "published") {
          recalc.phase = "published";
          assert.deepEqual(result?.result, { revision: event.id });
        } else {
          assert.equal(result, undefined);
          if (recalc.phase === "expired") {
            recalc.phase = "late-expired";
          }
        }
      }
      break;
    }
  }
  const next = engine.snapshot();
  check("S2", () => {
    assert.deepEqual(next.trials[0]?.revisions.slice(0, trial.revisions.length), trial.revisions);
    assert.equal(next.trials[0]?.rawBase64, trial.rawBase64);
  });
  check("S4", () =>
    assert.deepEqual(next.analyses.slice(0, actual.analyses.length), actual.analyses),
  );
  return next;
}

function verifyEdit(model: EditModel, actual: LifecycleState, check: Check) {
  const trial = actual.trials[0];
  const head = editHead(model);
  const active = model.jobs[head];
  check("S2", () => {
    assert.equal(trial?.rawBase64, rawBase64);
    assert.deepEqual(
      trial?.revisions.map((record) => [
        record.operation.revision_id,
        record.effectiveEdits[0]?.landmark.x,
      ]),
      model.revisions.map(({ id, value }) => [id, value]),
    );
    assert.deepEqual(
      Object.fromEntries(
        trial?.sessions.map((session) => [session.editorId, session.expectedHead ?? ""]) ?? [],
      ),
      model.sessions,
    );
  });
  check("S3", () => {
    assert.ok(trial);
    assert.deepEqual(
      trial.revisions.map((revision) => revision.version),
      model.revisions.map((_, index) => index + 1),
    );
    const engine = new LifecycleEngine(limits, settings, new MemoryStateStore(actual));
    const current = engine.currentAnalysis(trial.ack.trialId);
    assert.equal(
      current?.inputs.coordinateRevisionId,
      head === "" ? null : active?.phase === "published" ? head : undefined,
    );
    for (const revision of actual.analyses) {
      assert.deepEqual(engine.historicalAnalysis(revision.id), revision);
    }
  });
  check("S4", () => {
    assert.equal(actual.jobs.length, model.revisions.length + 1);
    assert.equal(
      new Set(actual.analyses.map((revision) => revision.jobId)).size,
      actual.analyses.length,
    );
    assert.equal(
      actual.analyses.length,
      Object.values(model.jobs).filter((job) => job.phase === "published").length + 1,
    );
  });
  check("L1", () => {
    assert.equal(actual.tick, model.tick);
    const states: Record<Recalc["phase"], string[]> = {
      queued: ["AnalysisQueued"],
      running: ["Recalculating"],
      expired: ["FailedRetryable"],
      "late-expired": ["FailedTerminal"],
      superseded: ["FailedTerminal"],
      published: ["Analyzed"],
    };
    for (const job of actual.jobs.slice(1)) {
      const recalc = model.jobs[job.inputs.coordinateRevisionId ?? ""];
      assert.ok(recalc);
      assert.ok(states[recalc.phase].includes(job.attempts[0].status));
      assert.ok(
        states[recalc.phase === "late-expired" ? "expired" : recalc.phase].includes(job.status),
      );
      if (recalc.phase === "queued" || recalc.phase === "running") {
        assert.ok(
          job.attempts[0].deadline > model.tick && job.attempts[0].deadline - model.tick <= 2,
        );
      }
    }
  });
  return active ? model.tick - active.entered : 0;
}

test("S2/S3/S4/L1 exhaustively replay two editors and overlapping recalc completions", () => {
  const engine = new LifecycleEngine(limits, settings);
  engine.submitCapture(capture("c1"));
  const initial = engine.snapshot().jobs[0];
  assert.ok(initial);
  engine.claim(initial.id);
  engine.complete(initial.id, 1, { revision: null }, raw);
  const visited = explore(
    "Editing S2/S3/S4/L1",
    {
      model: { tick: 0, revisions: [], sessions: {}, jobs: {} } as EditModel,
      actual: engine.snapshot(),
    },
    editEvents,
    replayEdit,
    verifyEdit,
    limits.queueDeadlineTicks + limits.execDeadlineTicks + 1,
    editStateKey,
  );
  const models = [...visited].map((key) => {
    const model = JSON.parse(key) as Pick<EditModel, "revisions"> & { jobs: [string, Recalc][] };
    return { ...model, jobs: new Map(model.jobs) };
  });
  checksForCoverage(
    "S2",
    ["r4", "r5"].every((id) => models.some((model) => model.revisions.at(-1)?.id === id)),
  );
  checksForCoverage(
    "S3",
    models.some(
      (model) =>
        model.jobs.get("r1")?.phase === "superseded" && model.jobs.get("r2")?.phase === "running",
    ),
  );
  checksForCoverage(
    "L1",
    models.some((model) => model.jobs.get("r2")?.phase === "late-expired"),
  );
}, 60000);

test("S3 a superseded recalc worker cannot publish after its replacement", () => {
  const engine = new LifecycleEngine(limits, settings);
  let trace: Trace<string> | undefined;
  function at<Result>(event: string, action: () => Result) {
    trace = { tick: 0, event, ...(trace && { previous: trace }) };
    try {
      return action();
    } catch (error) {
      throw counterexample("S3", trace, error);
    }
  }
  const trial = at("submit c1 and publish initial analysis", () => {
    const { trialId } = engine.submitCapture(capture("c1"));
    const initial = engine.snapshot().jobs[0];
    assert.ok(initial);
    assert.ok(engine.claim(initial.id));
    assert.ok(engine.complete(initial.id, 1, { revision: null }, raw));
    return trialId;
  });
  const old = at("e1 commits r1 and worker 1 claims its recalc", () => {
    engine.beginEdit(trial, "e1");
    const revision = engine.commitRevision(
      trial,
      "e1",
      coordinateOperation("r1", null, "edit", 11),
    );
    const claim = engine.claim(revision.jobId);
    assert.ok(claim);
    return claim;
  });
  const next = at("e2 commits r2 while worker 1 is outstanding and worker 2 claims r2", () => {
    engine.beginEdit(trial, "e2");
    const revision = engine.commitRevision(
      trial,
      "e2",
      coordinateOperation("r2", "r1", "edit", 22),
    );
    const claim = engine.claim(revision.jobId);
    assert.ok(claim);
    return claim;
  });
  const published = at("worker 2 completes r2 first", () => {
    const result = engine.complete(next.jobId, next.attemptNo, { revision: "r2" });
    assert.ok(result);
    return result;
  });
  at("worker 1 delivers superseded r1 after r2 published", () => {
    assert.equal(engine.complete(old.jobId, old.attemptNo, { revision: "r1" }), undefined);
    assert.equal(
      engine.snapshot().jobs.find((job) => job.id === old.jobId)?.attempts[0].failure,
      "superseded",
    );
    assert.deepEqual(engine.currentAnalysis(trial), published);
  });
});

test("S1/S4 recover from durable device and server stores after an ACK is lost", () => {
  const directory = mkdtempSync(join(tmpdir(), "verify-lifecycle-"));
  try {
    const devicePath = join(directory, "device.json");
    const serverPath = join(directory, "server.json");
    const device = () =>
      new CaptureQueue(limits, new FileStateStore(devicePath, emptyCaptureQueue()));
    const server = () =>
      new LifecycleEngine(
        limits,
        settings,
        new FileStateStore<LifecycleState>(serverPath, {
          tick: 0,
          trials: [],
          jobs: [],
          analyses: [],
        }),
      );
    const original = device();
    original.record(capture("c1"));
    original.recover();
    const first = original.start("a", "c1", true, ["1.0.0"]);
    assert.ok(first);
    const ack = server().submitCapture(first.capture);
    const restarted = device();
    restarted.recover();
    restarted.migrate("1.1.0");
    restarted.advanceTo(1);
    const retry = restarted.start("a", "c1", true, ["1.1.0"]);
    assert.ok(retry);
    assert.equal(retry.attemptNo, 2);
    assert.deepEqual(server().submitCapture(retry.capture), ack);
    assert.notEqual(server().submitCapture({ ...retry.capture, teamId: "b" }).trialId, ack.trialId);
    assert.equal(device().remove("a", "c1"), false);
    assert.equal(restarted.acknowledge("a", "c1", ack), true);
    assert.equal(device().remove("a", "c1"), true);
    assert.deepEqual(device().snapshot().captures[0]?.ack, ack);
    assert.throws(
      () => server().submitCapture({ ...retry.capture, video: Uint8Array.of(7) }),
      LifecycleConflict,
    );
  } catch (error) {
    throw counterexample(
      "S1",
      {
        tick: 1,
        event: "durable ACK recovery",
        previous: { tick: 0, event: "persist capture, upload and discard ACK" },
      },
      error,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
