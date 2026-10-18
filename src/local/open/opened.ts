import type { DiskState } from '../../platform/types'
import { zipFingerprint } from '../../zip/fingerprint'
import { readNxsp, type NxspRead, type ReadHistory } from '../nxsp'
import type { UndoStackForm } from '../nxsp/manifest'
import type { MediaForm, ProjectExtra, ProjectV1 } from '../nxsp/project'
import type { MediaKind, ReportItem } from '../nxsp/read'
import type { RecordValue } from '../records/canonical'
import type { SnapshotRecords } from '../records/encode'
import type { SnapshotParts } from '../worker/flushHandlers'
import { planImport, type ImportBatch } from './plan'

// Files this worker opened (Part 1 §1.5.4): each `.nxsp` read once here, kept while its open is
// stored and its background import runs, so the batches, and peeks of states not imported yet,
// read the file the tab opened. A worker restart loses them; the page reads the file again.

export type OpenedFile = {
    readonly id: string
    readonly file: Blob
    readonly read: NxspRead & { kind: 'nxsp' }
    /** The session its open stored, once stored. */
    sessionId?: string
    /** The import's batches, once stored with history. */
    plan?: ImportBatch[]
}

const opened = new Map<string, OpenedFile>()

let nextId = 0

/** What the page gets of a read: everything but the lazy chunk access. */
export type OpenReadReply =
    | { kind: 'not-project' }
    | { kind: 'unreadable'; report: ReportItem[] }
    | {
          kind: 'nxsp'
          id: string
          open: 'full' | 'partial'
          project?: ProjectV1
          extra: ProjectExtra
          level: unknown
          report: ReportItem[]
          media: Partial<Record<MediaKind, { form: MediaForm & { file: string }; bytes: Blob }>>
          /** The file's revision id and fingerprint, as a binding records them. */
          disk?: DiskState
          history?: {
              /** `history.entries`: the rows the file holds. */
              entries: number
              /** Rows whose state the file lacks (`kept: false`). */
              notKept: number
              head: string
              undoStack: UndoStackForm
              headRecords: SnapshotRecords
          }
      }

const lastModifiedOf = (file: Blob) => (file instanceof File ? file.lastModified : 0)

/** Reads a picked file; a `.nxsp` is kept here under the reply's id until dropped. */
export const readOpened = async (file: Blob): Promise<OpenReadReply> => {
    const read = await readNxsp(file)
    if (read.kind !== 'nxsp') return read
    const id = `open-${nextId++}`
    opened.set(id, { id, file, read })
    let disk: DiskState | undefined
    try {
        const lastModified = lastModifiedOf(file)
        disk = {
            ...(read.project?.revision ? { revisionId: read.project.revision.id } : {}),
            fingerprint: await zipFingerprint(file, lastModified),
            size: file.size,
            lastModified: Math.trunc(lastModified),
        }
    } catch {
        // A file whose directory can't be read has no fingerprint: it never binds anyway.
    }
    const { history } = read
    return {
        kind: 'nxsp',
        id,
        open: read.open,
        ...(read.project ? { project: read.project } : {}),
        extra: read.extra,
        level: read.level,
        report: read.report,
        media: Object.fromEntries(
            Object.entries(read.media).map(([kind, item]) => [
                kind,
                { form: item.form, bytes: item.bytes },
            ]),
        ),
        ...(disk ? { disk } : {}),
        ...(history
            ? {
                  history: {
                      entries: history.entries.length,
                      notKept: history.entries.filter((entry) => entry.kept === false).length,
                      head: history.head,
                      undoStack: history.undoStack,
                      headRecords: history.headRecords,
                  },
              }
            : {}),
    }
}

export const openedFile = (id: string) => opened.get(id)

/** The opened file whose import fills a session. */
export const openedForSession = (sessionId: string) => {
    for (const each of opened.values()) if (each.sessionId === sessionId) return each
}

export const dropOpened = (id: string) => {
    opened.delete(id)
}

/** Forgets every file opened for a session: its import ended. */
export const dropOpenedFor = (sessionId: string) => {
    for (const [id, each] of opened) if (each.sessionId === sessionId) opened.delete(id)
}

/** Ties a read to the session its open stored, and plans its import. */
export const attachOpened = (each: OpenedFile, sessionId: string, stored: ReadonlySet<string>) => {
    each.sessionId = sessionId
    if (each.read.history) each.plan = planImport(each.read.history, stored)
}

const decoder = new TextDecoder()

/**
 * A snapshot's parts from a file this worker opened, each verified against its hash: how a
 * peek or an undo reaches a state its import hasn't stored yet (§1.5.4). Undefined when no
 * opened file holds it whole.
 */
export const snapshotFromOpened = async (hex: string): Promise<SnapshotParts | undefined> => {
    for (const each of opened.values()) {
        const history: ReadHistory | undefined = each.read.history
        const root = history?.roots.get(hex)
        if (!history || !root) continue
        try {
            const nodes: Record<string, RecordValue[]> = {}
            const chunks: Record<string, unknown> = {}
            const chunk = async (hash: string) => {
                chunks[hash] = JSON.parse(decoder.decode(await history.chunks.read(hash)))
            }
            const node = async (hash: string) => {
                const json = history.nodes.get(hash)
                if (!json) throw new Error(`No node ${hash}`)
                nodes[hash] = json
                for (const child of json[2] as string[])
                    await (json[1] === 1 ? node(child) : chunk(child))
            }
            await chunk(root[1] as string)
            for (const [, top] of root[2] as [string, string][]) await node(top)
            return { root, nodes, chunks }
        } catch {
            // A part that fails its hash: the import finds it too and says so.
        }
    }
}
