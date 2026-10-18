// `.nxsp` v1 (§1.6.11.4–§1.6.11.9): the reader, the builder's format half, the executor and inspect.
export {
    ANCESTOR_LIMIT,
    SEGMENT_ENTRIES,
    planNxsp,
    savedAtOf,
    type BuildContext,
    type BuildInput,
    type BuildResult,
    type HistoryInput,
    type InputChunk,
    type MediaInput,
    type PlannedChunk,
} from './build'
export {
    ExecutionError,
    buildNxsp,
    executePlan,
    type ExecutionErrorCode,
    type ExecutionSource,
} from './execute'
export { inspectNxsp } from './inspect'
export {
    ENTRY_KINDS,
    type EntryForm,
    type HistoryForm,
    type ManifestForm,
    type SegmentForm,
    type SlotForm,
    type UndoStackForm,
} from './manifest'
export {
    PlanError,
    type CopyCheck,
    type PinnedSource,
    type PlanLimit,
    type PlanPart,
    type PlannedEntry,
    type SourceEntry,
    type WritePlan,
} from './plan'
export {
    assetEntryName,
    bgmEntryName,
    bgmFilenameOf,
    currentSummary,
    levelInfoOf,
    mediaRefOf,
    metadataOf,
    placedCompleteFrom,
    summaryOf,
    type MediaForm,
    type ProjectExtra,
    type ProjectV1,
    type RevisionForm,
} from './project'
export {
    NXSP_CAPS,
    readNxsp,
    type ChunkAccess,
    type NxspCaps,
    type NxspRead,
    type ReadHistory,
    type ReadMedia,
    type ReportItem,
    type ReportReason,
} from './read'
export {
    MANIFEST_VERSION,
    MINOR_TABLE,
    NXSP_FORMAT,
    NXSP_MINOR,
    NXSP_VERSION,
    minorOf,
} from './version'
