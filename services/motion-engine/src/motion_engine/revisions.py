from collections import defaultdict

from .contracts import CoordinateRevision, Landmark2D, Pose2DSequence


def effective_revisions(
    revisions: list[CoordinateRevision],
    contract_version: str,
    raw_revision_id: str | None,
) -> tuple[list[CoordinateRevision], str | None]:
    head = raw_revision_id
    committed: dict[str, CoordinateRevision] = {}
    active: list[CoordinateRevision] = []
    undone: list[CoordinateRevision] = []
    for revision in revisions:
        previous = committed.get(revision.revision_id)
        if previous is not None:
            if previous != revision:
                raise ValueError("revision ID reused with different content")
            continue
        if (
            revision.contract_version != contract_version
            or revision.revision_id == raw_revision_id
            or revision.expected_head != head
            or revision.parent_revision_id != head
        ):
            raise ValueError("revision version or append history does not match")
        if revision.operation == "edit":
            active.append(revision)
            undone.clear()
        elif revision.operation == "undo":
            if not active:
                raise ValueError("nothing to undo")
            undone.append(active.pop())
        else:
            if not undone:
                raise ValueError("nothing to redo")
            active.append(undone.pop())
        head = revision.revision_id
        committed[head] = revision
    return active, head


def apply_revisions(
    raw: Pose2DSequence, revisions: list[CoordinateRevision]
) -> Pose2DSequence:
    initial_head = revisions[0].parent_revision_id if revisions else None
    active, _ = effective_revisions(revisions, raw.contract_version, initial_head)
    edits: dict[int, dict[str, Landmark2D]] = defaultdict(dict)
    valid_frames = {frame.frame_index for frame in raw.frames}
    for revision in revisions:
        for edit in revision.edits:
            if edit.view_id == raw.view_id and edit.frame_index not in valid_frames:
                raise ValueError("edit references an unknown frame")
    for revision in active:
        for edit in revision.edits:
            if edit.view_id == raw.view_id:
                edits[edit.frame_index][edit.landmark.landmark_id] = (
                    edit.landmark.model_copy(update={"source": "manual_edit"})
                )
    result = raw.model_copy(deep=True)
    for frame in result.frames:
        replacements = edits.get(frame.frame_index)
        if replacements:
            landmarks = {point.landmark_id: point for point in frame.landmarks}
            if len(landmarks) != len(frame.landmarks):
                raise ValueError("duplicate landmark ID in edited frame")
            frame.landmarks[:] = (landmarks | replacements).values()
    return result
