import assert from "node:assert/strict";
import {
  asFrameIndex,
  asSeconds,
  CONTRACT_VERSION,
  type KinematicMetrics,
} from "@sports-motion/contracts";
import fc from "fast-check";
import { test } from "vitest";
import {
  addAnnotation,
  addComment,
  type CoachingComment,
  type CoachingReferenceBand,
  commentsAtFrame,
  compareTwoTrials,
  DEFAULT_NON_DIAGNOSTIC_DISCLAIMER_JA,
  type DrawingAnnotation,
  PLAYBACK_RATES,
  removeAnnotation,
  removeComment,
  SynchronizedPlaybackController,
  validateCoachingComment,
  validateDrawingAnnotation,
  validateMovementEvents,
  visibleAnnotationsAtFrame,
} from "../src/index.js";

function makeProvenance(revisionId: string): KinematicMetrics["provenance"] {
  return {
    contract_version: CONTRACT_VERSION,
    pipeline_version: "1.0.0",
    stage_models: [{ stage: "filter_and_kinematics", model_hash: "none", license_tier: "A" }],
    filter_spec_version: "1.0.0",
    calibration_id_or_none: "calibration-dlt",
    coordinate_revision_id: `coords-${revisionId}`,
  };
}

function makeRunningMetrics(
  revisionId: string,
  points: [
    { normalized_time_fraction: number; value: number },
    { normalized_time_fraction: number; value: number },
    ...{ normalized_time_fraction: number; value: number }[],
  ],
  overrides: Partial<KinematicMetrics> = {},
): KinematicMetrics {
  return {
    contract_version: CONTRACT_VERSION,
    analysis_revision_id: revisionId,
    movement_type: "running",
    provenance: makeProvenance(revisionId),
    events: [
      {
        event_id: "run_initial_contact",
        frame_index: asFrameIndex(10),
        timestamp_sec: asSeconds(0.1),
        detection_mode: "manual",
        side: "right",
      },
      {
        event_id: "run_toe_off",
        frame_index: asFrameIndex(40),
        timestamp_sec: asSeconds(0.4),
        detection_mode: "automatic",
        side: "right",
      },
      {
        event_id: "run_next_initial_contact",
        frame_index: asFrameIndex(90),
        timestamp_sec: asSeconds(0.9),
        detection_mode: "manual",
        side: "right",
      },
    ],
    scalar_metrics: [
      {
        metric_id: "run_knee_flexion_extension_angle",
        event_id: "run_initial_contact",
        value_or_null: points[0].value,
        unit: "deg",
        anatomical_plane: "sagittal",
        missing_reason_or_null: null,
        side: "right",
      },
      {
        metric_id: "run_ankle_dorsiflexion_plantarflexion_angle",
        event_id: "run_initial_contact",
        value_or_null: null,
        unit: "deg",
        anatomical_plane: "sagittal",
        missing_reason_or_null: "occluded",
        side: "right",
      },
    ],
    normalized_waveforms: [
      {
        metric_id: "run_knee_flexion_extension_angle",
        interval_id: "run_stride",
        unit: "deg",
        anatomical_plane: "sagittal",
        side: "right",
        points,
      },
    ],
    ...overrides,
  };
}

test("validateMovementEvents accepts strictly increasing movement-specific events and rejects invalid ones", () => {
  const validPitch = validateMovementEvents("baseball_pitching", [
    {
      event_id: "pitch_leg_lift",
      frame_index: asFrameIndex(10),
      timestamp_sec: asSeconds(0.05),
      detection_mode: "manual",
    },
    {
      event_id: "pitch_foot_contact",
      frame_index: asFrameIndex(50),
      timestamp_sec: asSeconds(0.25),
      detection_mode: "automatic",
    },
    {
      event_id: "pitch_mir",
      frame_index: asFrameIndex(90),
      timestamp_sec: asSeconds(0.45),
      detection_mode: "manual",
    },
  ]);
  assert.equal(validPitch.movement, "baseball_pitching");
  assert.equal(validPitch.events.length, 3);
  assert.ok(Math.abs(validPitch.durationSec - 0.4) < 1e-12);

  // Wrong movement event
  assert.throws(
    () =>
      validateMovementEvents("running", [
        {
          event_id: "pitch_leg_lift",
          frame_index: asFrameIndex(1),
          timestamp_sec: asSeconds(0.1),
          detection_mode: "manual",
        },
        {
          event_id: "run_next_initial_contact",
          frame_index: asFrameIndex(10),
          timestamp_sec: asSeconds(0.5),
          detection_mode: "manual",
        },
      ]),
    RangeError,
  );

  // Duplicate event
  assert.throws(
    () =>
      validateMovementEvents("cmj", [
        {
          event_id: "cmj_initiation",
          frame_index: asFrameIndex(1),
          timestamp_sec: asSeconds(0.1),
          detection_mode: "manual",
        },
        {
          event_id: "cmj_initiation",
          frame_index: asFrameIndex(10),
          timestamp_sec: asSeconds(0.5),
          detection_mode: "manual",
        },
      ]),
    RangeError,
  );

  // Zero-duration interval (G5)
  assert.throws(
    () =>
      validateMovementEvents("dvj", [
        {
          event_id: "dvj_initial_landing_contact",
          frame_index: asFrameIndex(10),
          timestamp_sec: asSeconds(0.5),
          detection_mode: "manual",
        },
        {
          event_id: "dvj_takeoff",
          frame_index: asFrameIndex(20),
          timestamp_sec: asSeconds(0.5),
          detection_mode: "manual",
        },
      ]),
    RangeError,
  );

  // Non-increasing frame index
  assert.throws(
    () =>
      validateMovementEvents("dvj", [
        {
          event_id: "dvj_initial_landing_contact",
          frame_index: asFrameIndex(20),
          timestamp_sec: asSeconds(0.2),
          detection_mode: "manual",
        },
        {
          event_id: "dvj_takeoff",
          frame_index: asFrameIndex(20),
          timestamp_sec: asSeconds(0.4),
          detection_mode: "manual",
        },
      ]),
    RangeError,
  );

  // Single event cannot define a non-zero interval
  assert.throws(
    () =>
      validateMovementEvents("running", [
        {
          event_id: "run_initial_contact",
          frame_index: asFrameIndex(1),
          timestamp_sec: asSeconds(0.1),
          detection_mode: "manual",
        },
      ]),
    RangeError,
  );
});

test("compareTwoTrials aligns shifted waveforms, computes analytical metrics, skips null scalars, and overlays reference bands", () => {
  const baseline = makeRunningMetrics("rev-a", [
    { normalized_time_fraction: 0, value: 10 },
    { normalized_time_fraction: 0.4, value: 50 },
    { normalized_time_fraction: 1, value: 20 },
  ]);
  const target = makeRunningMetrics("rev-b", [
    { normalized_time_fraction: 0, value: 14 },
    { normalized_time_fraction: 0.5, value: 58 },
    { normalized_time_fraction: 1, value: 24 },
  ]);
  const referenceBand: CoachingReferenceBand = {
    metric_id: "run_knee_flexion_extension_angle",
    interval_id: "run_stride",
    unit: "deg",
    source: { kind: "synthetic", dataset: "Coaching test trials" },
    points: [
      { percent_0_to_100: 0, mean: 12, sd: 3 },
      { percent_0_to_100: 50, mean: 52, sd: 5 },
      { percent_0_to_100: 100, mean: 22, sd: 3 },
    ],
  };

  const result = compareTwoTrials({
    baseline,
    target,
    metricId: "run_knee_flexion_extension_angle",
    intervalId: "run_stride",
    side: "right",
    referenceBand,
  });

  assert.equal(result.non_diagnostic_flag, true);
  assert.equal(result.disclaimer_text_ja, DEFAULT_NON_DIAGNOSTIC_DISCLAIMER_JA);
  assert.deepEqual(
    result.series.map(({ percent }) => percent),
    [0, 40, 50, 100],
  );
  // At 40%: baseline = 50, target interpolated linearly between (0, 14) and (0.5, 58) => 14 + 0.8 * 44 = 49.2
  assert.ok(Math.abs((result.series[1]?.targetValue ?? 0) - 49.2) < 1e-12);
  assert.ok(Math.abs((result.series[1]?.delta ?? 0) - -0.8) < 1e-12);
  // At 50%: baseline interpolated between (0.4, 50) and (1, 20) => 50 - (0.1/0.6)*30 = 45, target = 58
  assert.ok(Math.abs((result.series[2]?.baselineValue ?? 0) - 45) < 1e-12);
  assert.ok(Math.abs((result.series[2]?.delta ?? 0) - 13) < 1e-12);

  assert.equal(result.peakBaseline.percent, 40);
  assert.equal(result.peakBaseline.value, 50);
  assert.equal(result.peakTarget.percent, 50);
  assert.equal(result.peakTarget.value, 58);
  assert.equal(result.peakDelta, 8);
  assert.equal(result.peakPhaseShiftPercent, 10);

  const expectedRms = Math.sqrt((4 ** 2 + (-0.8) ** 2 + 13 ** 2 + 4 ** 2) / 4);
  assert.ok(Math.abs(result.rmsDifference - expectedRms) < 1e-12);

  // Reference band values attached via @sports-motion/evidence
  assert.equal(result.series[0]?.referenceLower1Sd, 9);
  assert.equal(result.series[0]?.referenceUpper1Sd, 15);
  assert.equal(result.series[2]?.referenceLower1Sd, 47);
  assert.equal(result.series[2]?.referenceUpper1Sd, 57);
  assert.ok(result.referenceBandSummary !== undefined);
  assert.equal(result.referenceBandSummary.targetInBandRatio, 0.5);

  // Null scalar metric skipped cleanly without fabrication
  assert.equal(result.scalarDeltas.length, 1);
  assert.equal(result.scalarDeltas[0]?.metricId, "run_knee_flexion_extension_angle");
  assert.equal(result.scalarDeltas[0]?.delta, 4);
});

test("compareTwoTrials enforces G3 guards against mismatched movements, units, or missing waveforms", () => {
  const baseline = makeRunningMetrics("rev-a", [
    { normalized_time_fraction: 0, value: 10 },
    { normalized_time_fraction: 1, value: 20 },
  ]);
  const wrongMovement = makeRunningMetrics(
    "rev-b",
    [
      { normalized_time_fraction: 0, value: 10 },
      { normalized_time_fraction: 1, value: 20 },
    ],
    { movement_type: "cmj" },
  );
  assert.throws(
    () =>
      compareTwoTrials({
        baseline,
        target: wrongMovement,
        metricId: "run_knee_flexion_extension_angle",
        intervalId: "run_stride",
      }),
    RangeError,
  );

  const wrongUnit = structuredClone(baseline);
  wrongUnit.analysis_revision_id = "rev-rad";
  const [wrongUnitWave] = wrongUnit.normalized_waveforms;
  assert.ok(wrongUnitWave);
  wrongUnitWave.unit = "rad";
  assert.throws(
    () =>
      compareTwoTrials({
        baseline,
        target: wrongUnit,
        metricId: "run_knee_flexion_extension_angle",
        intervalId: "run_stride",
      }),
    RangeError,
  );

  assert.throws(
    () =>
      compareTwoTrials({
        baseline,
        target: baseline,
        metricId: "pitch_elbow_flexion_angle",
        intervalId: "pitch_cycle",
      }),
    RangeError,
  );

  const nonFinite = structuredClone(baseline);
  const [nonFiniteWave] = nonFinite.normalized_waveforms;
  assert.ok(nonFiniteWave);
  nonFiniteWave.points[0].value = Number.NaN;
  assert.throws(
    () =>
      compareTwoTrials({
        baseline: nonFinite,
        target: baseline,
        metricId: "run_knee_flexion_extension_angle",
        intervalId: "run_stride",
      }),
    /TypeError|RangeError/u,
  );
});

test("compareTwoTrials rejects malformed trial events and ambiguous metrics", () => {
  const baseline = makeRunningMetrics("rev-a", [
    { normalized_time_fraction: 0, value: 12 },
    { normalized_time_fraction: 1, value: 20 },
  ]);
  const [start, mid, end] = baseline.events;
  const [waveform] = baseline.normalized_waveforms;
  const [scalar] = baseline.scalar_metrics;
  assert.ok(start && mid && end && waveform && scalar);
  const compare = (target: KinematicMetrics) =>
    compareTwoTrials({
      baseline,
      target,
      metricId: waveform.metric_id,
      intervalId: waveform.interval_id,
      side: "right",
    });

  assert.throws(() => compare({ ...baseline, events: [start, mid] }), /interval/u);
  assert.throws(
    () => compare({ ...baseline, events: [start, { ...mid, event_id: "pitch_mer" }, end] }),
    /not allowed/u,
  );
  assert.throws(() => compare({ ...baseline, events: [start, end, mid] }), /increasing/u);
  assert.throws(
    () => compare({ ...baseline, events: [start, { ...end, timestamp_sec: start.timestamp_sec }] }),
    /increasing/u,
  );
  assert.throws(
    () => compare({ ...baseline, normalized_waveforms: [waveform, waveform] }),
    /Multiple waveforms/u,
  );
  assert.throws(
    () => compare({ ...baseline, scalar_metrics: [scalar, scalar] }),
    /Duplicate scalar/u,
  );

  const result = compare({ ...baseline, events: [start, { ...start, side: "left" }, mid, end] });
  assert.deepEqual(result.targetEventRange, {
    startFrame: 10,
    endFrame: 90,
    durationSec: 0.8,
  });
  const stance: KinematicMetrics = {
    ...baseline,
    normalized_waveforms: [{ ...waveform, interval_id: "run_stance" }],
  };
  const comparison = compareTwoTrials({
    baseline: stance,
    target: stance,
    metricId: waveform.metric_id,
    intervalId: "run_stance",
  });
  assert.equal(comparison.baselineEventRange.startFrame, start.frame_index);
  assert.equal(comparison.baselineEventRange.endFrame, mid.frame_index);
});

test("reference-only sample phases preserve band extrema and trial RMS", () => {
  const baseline = makeRunningMetrics("rev-a", [
    { normalized_time_fraction: 0, value: 10 },
    { normalized_time_fraction: 1, value: 30 },
  ]);
  const target = makeRunningMetrics("rev-b", [
    { normalized_time_fraction: 0, value: 10 },
    { normalized_time_fraction: 1, value: 40 },
  ]);
  const input = {
    baseline,
    target,
    metricId: "run_knee_flexion_extension_angle",
    intervalId: "run_stride",
  } as const;
  const comparison = compareTwoTrials({
    ...input,
    referenceBand: {
      metric_id: input.metricId,
      interval_id: input.intervalId,
      unit: "deg",
      source: { kind: "synthetic", dataset: "Coaching test trials" },
      points: [
        { percent_0_to_100: 0, mean: 10, sd: 1 },
        { percent_0_to_100: 50, mean: 60, sd: 5 },
        { percent_0_to_100: 100, mean: 30, sd: 1 },
      ],
    },
  });
  assert.deepEqual(
    comparison.series.find(({ percent }) => percent === 50),
    {
      percent: 50,
      baselineValue: 20,
      targetValue: 25,
      delta: 5,
      referenceLower1Sd: 55,
      referenceUpper1Sd: 65,
    },
  );
  assert.equal(comparison.rmsDifference, compareTwoTrials(input).rmsDifference);
  assert.deepEqual(comparison.referenceBandSummary, {
    baselineInBandRatio: 1,
    targetInBandRatio: 0.5,
    source: { kind: "synthetic", dataset: "Coaching test trials" },
  });
});

test("normalizes floating-point phase aliases to one plotted point", () => {
  const baseline = makeRunningMetrics("rev-a", [
    { normalized_time_fraction: 0, value: 10 },
    { normalized_time_fraction: 0.35000000000000003, value: 20 },
    { normalized_time_fraction: 1, value: 30 },
  ]);
  const comparison = compareTwoTrials({
    baseline,
    target: baseline,
    metricId: "run_knee_flexion_extension_angle",
    intervalId: "run_stride",
    referenceBand: {
      metric_id: "run_knee_flexion_extension_angle",
      interval_id: "run_stride",
      unit: "deg",
      source: { kind: "synthetic", dataset: "Coaching test trials" },
      points: [
        { percent_0_to_100: 0, mean: 10, sd: 2 },
        { percent_0_to_100: 35, mean: 20, sd: 2 },
        { percent_0_to_100: 100, mean: 30, sd: 2 },
      ],
    },
  });
  assert.deepEqual(
    comparison.series.map(({ percent }) => percent),
    [0, 35, 100],
  );
  assert.equal(comparison.series[1]?.baselineValue, 20);
  assert.equal(comparison.series[1]?.referenceUpper1Sd, 22);
});

test("reference band values require source metadata", () => {
  const trial = makeRunningMetrics("rev-a", [
    { normalized_time_fraction: 0, value: 10 },
    { normalized_time_fraction: 1, value: 30 },
  ]);
  assert.throws(
    () =>
      compareTwoTrials({
        baseline: trial,
        target: trial,
        metricId: "run_knee_flexion_extension_angle",
        intervalId: "run_stride",
        referenceBand: {
          metric_id: "run_knee_flexion_extension_angle",
          interval_id: "run_stride",
          unit: "deg",
          points: [
            { percent_0_to_100: 0, mean: 10, sd: 2 },
            { percent_0_to_100: 100, mean: 30, sd: 2 },
          ],
        } as unknown as CoachingReferenceBand,
      }),
    /source metadata/u,
  );
});

test("compareTwoTrials satisfies antisymmetry delta(A, B) === -delta(B, A) and symmetric RMS", () => {
  const valueArb = fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true });
  const midFractionArb = fc.double({
    min: 0.05,
    max: 0.95,
    noNaN: true,
    noDefaultInfinity: true,
  });

  fc.assert(
    fc.property(
      valueArb,
      valueArb,
      valueArb,
      midFractionArb,
      valueArb,
      valueArb,
      valueArb,
      midFractionArb,
      (a0, aMid, a1, fracA, b0, bMid, b1, fracB) => {
        const trialA = makeRunningMetrics("rev-a", [
          { normalized_time_fraction: 0, value: a0 },
          { normalized_time_fraction: fracA, value: aMid },
          { normalized_time_fraction: 1, value: a1 },
        ]);
        const trialB = makeRunningMetrics("rev-b", [
          { normalized_time_fraction: 0, value: b0 },
          { normalized_time_fraction: fracB, value: bMid },
          { normalized_time_fraction: 1, value: b1 },
        ]);
        const ab = compareTwoTrials({
          baseline: trialA,
          target: trialB,
          metricId: "run_knee_flexion_extension_angle",
          intervalId: "run_stride",
        });
        const ba = compareTwoTrials({
          baseline: trialB,
          target: trialA,
          metricId: "run_knee_flexion_extension_angle",
          intervalId: "run_stride",
        });
        assert.equal(ab.series.length, ba.series.length);
        for (let index = 0; index < ab.series.length; index += 1) {
          assert.ok(ab.series[index]?.delta === -(ba.series[index]?.delta ?? 0));
        }
        assert.ok(ab.peakDelta === -ba.peakDelta);
        assert.ok(ab.peakPhaseShiftPercent === -ba.peakPhaseShiftPercent);
        assert.equal(ab.rmsDifference, ba.rmsDifference);
      },
    ),
    { seed: 59, numRuns: 200 },
  );
});

test("drawing annotations and coaching comments validate bounds, hex colors, immutability, and frame visibility", () => {
  const line: DrawingAnnotation = {
    id: "ann-line",
    kind: "line",
    startFrame: asFrameIndex(10),
    endFrame: asFrameIndex(20),
    points: [
      { x: 0.1, y: 0.2 },
      { x: 0.8, y: 0.7 },
    ],
    colorHex: "#047c6d",
  };
  const label: DrawingAnnotation = {
    id: "ann-label",
    kind: "label",
    startFrame: asFrameIndex(15),
    endFrame: asFrameIndex(25),
    points: [{ x: 0.5, y: 0.5 }],
    colorHex: "#ba4b2b",
    label: "Check knee alignment",
  };

  const list0: readonly DrawingAnnotation[] = [];
  const list1 = addAnnotation(list0, line);
  const list2 = addAnnotation(list1, label);
  assert.equal(list0.length, 0);
  assert.equal(list1.length, 1);
  assert.equal(list2.length, 2);

  assert.deepEqual(
    visibleAnnotationsAtFrame(list2, 12).map(({ id }) => id),
    ["ann-line"],
  );
  assert.deepEqual(
    visibleAnnotationsAtFrame(list2, 18).map(({ id }) => id),
    ["ann-line", "ann-label"],
  );
  assert.deepEqual(
    visibleAnnotationsAtFrame(list2, 30).map(({ id }) => id),
    [],
  );

  const listAfterRemove = removeAnnotation(list2, "ann-line");
  assert.equal(list2.length, 2);
  assert.deepEqual(
    listAfterRemove.map(({ id }) => id),
    ["ann-label"],
  );

  // Invalid bounds, color, frame order
  assert.throws(
    () =>
      validateDrawingAnnotation({
        ...line,
        points: [
          { x: -0.1, y: 0.2 },
          { x: 0.5, y: 0.5 },
        ],
      }),
    RangeError,
  );
  assert.throws(() => validateDrawingAnnotation({ ...line, colorHex: "red" }), RangeError);
  assert.throws(
    () =>
      validateDrawingAnnotation({
        ...line,
        startFrame: asFrameIndex(25),
        endFrame: asFrameIndex(20),
      }),
    RangeError,
  );
  assert.throws(() => addAnnotation(list1, line), RangeError);

  const textComment: CoachingComment = {
    id: "cmt-1",
    kind: "text",
    frameIndex: asFrameIndex(18),
    authorRole: "Coach",
    createdAt: "2026-11-20T10:00:00Z",
    text: "Maintain upright trunk at contact",
  };
  const voiceComment: CoachingComment = {
    id: "cmt-2",
    kind: "voice_note",
    frameIndex: asFrameIndex(18),
    authorRole: "OrgAdmin",
    createdAt: "2026-11-20T10:01:00Z",
    audioDurationSec: 12.5,
  };
  const comments = addComment(addComment([], textComment), voiceComment);
  assert.equal(commentsAtFrame(comments, 18).length, 2);
  assert.equal(removeComment(comments, "cmt-1").length, 1);

  assert.throws(() => validateCoachingComment({ ...textComment, text: "   " }), TypeError);
  assert.throws(
    () => validateCoachingComment({ ...voiceComment, audioDurationSec: 0 }),
    RangeError,
  );
});

test("SynchronizedPlaybackController supports slow-mo rates 0.1x-1.0x and event-synchronized scrubbing within <= 1 frame", () => {
  const controller = new SynchronizedPlaybackController(
    {
      totalFrames: 120,
      fps: 120,
      startFrame: asFrameIndex(20),
      endFrame: asFrameIndex(100),
    },
    {
      totalFrames: 240,
      fps: 240,
      startFrame: asFrameIndex(30),
      endFrame: asFrameIndex(230),
    },
  );

  for (const rate of PLAYBACK_RATES) {
    assert.equal(controller.setRate(rate).rate, rate);
  }
  assert.throws(() => controller.setRate(0.75 as 1.0), RangeError);

  for (const percent of [0, 12.5, 25, 50, 73.3, 100]) {
    const state = controller.seekPercent(percent);
    assert.ok(state.syncDeltaFrames <= 1, `syncDeltaFrames=${state.syncDeltaFrames}`);
  }
  const mid = controller.seekPercent(50);
  assert.equal(mid.baselineFrame, 60);
  assert.equal(mid.targetFrame, 130);
  assert.equal(mid.syncDeltaFrames, 0);

  const steppedUp = controller.stepFrame(1);
  assert.equal(steppedUp.baselineFrame, 61);
  assert.ok(steppedUp.syncDeltaFrames <= 1);
  const steppedDown = controller.stepFrame(-1);
  assert.equal(steppedDown.baselineFrame, 60);

  // Slow-mo advance at 0.25x over 0.4s real time -> 0.1s motion time out of (80/120)=0.6667s => +15%
  controller.seekPercent(0);
  controller.setRate(0.25);
  controller.play();
  const advanced = controller.advance(0.4);
  assert.ok(Math.abs(advanced.percent - 15) < 1e-9);
  assert.equal(advanced.playing, true);
  assert.equal(controller.pause().playing, false);
});
