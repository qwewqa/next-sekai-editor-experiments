import {
    captureEntryDescription,
    captureStep,
    type EntryDescription,
    type UndoableStep,
} from '../../history/operations'
import { serializeEditorMetadata } from '../../levelData/editorMetadata'
import { LEVEL_VERSION } from '../../levelData/levelVersion'
import { serializeToLevelData } from '../../levelData/serialize'
import type { State } from '../../state'
import type { PendingEntry as FlushPendingEntry } from '../flush'
import { toHex } from '../hash'
import { summaryOf } from '../nxsp/project'
import { toRecords } from '../records/records'
import { encodeSnapshot } from '../records/snapshot'
import type { PendingRecords } from './bodies'
import type { HeadInput, PendingInput, PendingRow } from './build'

// The page's half of a build's first source (Part 1 §1.6.11.6): this tab's records not yet
// flushed, and the live head's level data, posted to the worker for the Save. Encoded here with
// the synchronous hash; the worker checks them as it checks storage's.

/** Adds a state's snapshot to `records`; returns its root as hex. */
export const addRecords = (records: PendingRecords, state: State) => {
    const snapshot = encodeSnapshot(toRecords(state))
    const root = toHex(snapshot.root.hash)
    records.roots[root] = snapshot.root.json
    for (const node of snapshot.nodes) records.nodes[toHex(node.hash)] = node.json
    for (const chunk of [snapshot.header, ...snapshot.chunks])
        records.chunks[toHex(chunk.hash)] = chunk.bytes
    return root
}

export const pendingFlushRow = (
    entry: FlushPendingEntry,
    records: PendingRecords,
): PendingRow | undefined => {
    const snapshot = entry.state
        ? addRecords(records, entry.state)
        : entry.snapshot && toHex(entry.snapshot)
    if (!snapshot) return
    const root = records.roots[snapshot]
    return {
        seq: entry.seq,
        time: entry.wall,
        ...captureEntryDescription(entry),
        snapshot,
        // A stored slot's count isn't known here: it is left out, never written as 0, and the
        // writer takes it from the root it holds.
        ...(typeof root?.[3] === 'number' ? { noteCount: root[3] } : {}),
        dirty: entry.dirty,
        ...(entry.recoveryBaseline
            ? {
                  stack: {
                      keep: 0,
                      push: [{ snapshot, step: captureStep(entry.recoveryBaseline) }],
                      index: 0,
                  },
              }
            : {}),
        ...(entry.revisionId === undefined ? {} : { revisionId: entry.revisionId }),
        ...(entry.device ? { device: { ...entry.device } } : {}),
        ...(entry.appVersion === undefined ? {} : { appVersion: entry.appVersion }),
    }
}

export type PendingEntry = EntryDescription &
    Omit<
        PendingRow,
        'snapshot' | 'noteCount' | 'kind' | 'step' | 'operation' | 'recoveryContext'
    > & { state: State }

/** This tab's unflushed rows of the saved session, its live stack and their records. */
export const pendingInput = (
    entries: readonly PendingEntry[],
    stack?: { base: number; slots: readonly { state: State; step: UndoableStep }[]; index: number },
): PendingInput => {
    const records: PendingRecords = { roots: {}, nodes: {}, chunks: {} }
    const rows = entries.map(({ state, ...row }) => {
        const snapshot = addRecords(records, state)
        return {
            seq: row.seq,
            time: row.time,
            dirty: row.dirty,
            ...(row.stack ? { stack: row.stack } : {}),
            ...(row.revisionId === undefined ? {} : { revisionId: row.revisionId }),
            ...(row.device ? { device: row.device } : {}),
            ...(row.appVersion === undefined ? {} : { appVersion: row.appVersion }),
            ...captureEntryDescription(row),
            snapshot,
            noteCount: records.roots[snapshot]?.[3] as number,
        }
    })
    return {
        entries: rows,
        ...(stack
            ? {
                  stack: {
                      base: stack.base,
                      slots: stack.slots.map(({ state, step }) => ({
                          snapshot: addRecords(records, state),
                          step: captureStep(step),
                      })),
                      index: stack.index,
                  },
              }
            : {}),
        records,
    }
}

/** The live head's level data and header, as the worker would decode them. */
export const headInput = (state: State): HeadInput => {
    const level = serializeToLevelData(
        state.initialLife,
        state.isDynamicStages,
        state.bgm.offset,
        state.store,
        state.groups,
        state.stages,
        { groups: state.groupFolders, stages: state.stageFolders },
    )
    const records = toRecords(state)
    return {
        snapshot: toHex(encodeSnapshot(records).root.hash),
        level,
        editor: serializeEditorMetadata(level.entities, state.store),
        summary: summaryOf(records),
        levelInfo: state.levelInfo,
        ...(state.bgm.meta ? { bgm: state.bgm.meta } : {}),
        levelVersion: LEVEL_VERSION,
    }
}
