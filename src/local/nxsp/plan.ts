// The writer's interface (§1.6.11.7): the builder's input is the pinned sources' metadata and its
// output a plan; it never reads a source's bytes. The executor turns a plan into the file's bytes,
// and the same plan gives the same bytes on every platform.

/** A pinned source's central-directory entry, with where its stored data starts. */
export type SourceEntry = {
    /** Its position in the central directory. */
    index: number
    name: string
    method: 0 | 8
    /** From the central directory. */
    crc32: number
    compressedSize: number
    uncompressedSize: number
    /** After its local header, whose own name and extra lengths are read. */
    dataOffset: number
}

/** A file pinned at the changed-on-disk check, as the builder sees it. */
export type PinnedSource = {
    /** Names the pinned file for the executor. */
    token: string
    /** The file being replaced, or in the apps a version on this device at the chain's base. */
    role: 'target' | 'base'
    fingerprint: string
    size: number
    /** Its central directory, in order. */
    entries: SourceEntry[]
    projectJson: unknown
    /** The parsed manifest and segments (in `history.segments` order), when they are there. */
    manifest?: { manifest: unknown; segments: unknown[] }
}

/** The DOS time and date every entry is written with. */
export type Modified = { dosTime: number; dosDate: number }

export type CopyCheck = { kind: 'entryCrc' }

export type PlanPart =
    /** New data, already deflated for method 8. */
    | { kind: 'bytes'; data: Uint8Array }
    /** A source entry's whole data, by its central-directory index; with `inflate`, uncompressed. */
    | {
          kind: 'copy'
          source: string
          entryIndex: number
          dataOffset: number
          inflate?: true
          check: CopyCheck
      }

export type PlannedEntry = {
    name: string
    method: 0 | 8
    /** Given when the builder knows it; required for method 8. */
    crc32?: number
    uncompressedSize?: number
    parts: PlanPart[]
}

export type WritePlan = {
    modified: Modified
    entries: PlannedEntry[]
}

/** A plan that breaks the contract: a bug, never a user gate (§1.6.11.7). */
export class PlanError extends Error {
    override name = 'PlanError'
}

/** The highest value a ZIP32 size or offset field holds below the ZIP64 sentinel. */
export const ZIP32_LIMIT = 0xffffffff

/** A file of this many entries would need ZIP64 (§1.6.11.4). */
export const ENTRY_LIMIT = 0xffff
