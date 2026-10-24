import type { LevelDataEntity } from '@sonolus/core'
import type { Chart } from '../../chart'
import type { LevelDataReport } from '../../levelData/report'
import { createState, type State } from '../../state'
import type { BgmMeta } from '../../state/bgm'
import type { LevelInfo } from '../../state/levelInfo'
import type { MediaForm, ProjectV1 } from '../nxsp/project'
import { bgmFilenameOf, levelInfoOf, mediaRefOf } from '../nxsp/project'
import type { MediaKind, ReportItem } from '../nxsp/read'
import { canonical } from '../records/canonical'
import { levelDataMatchesState } from '../records/normalised'
import { levelInfoRecord } from '../records/records'

// The open's decisions, apart from the editor so Node tests run them:
// which line a partial open shows, the name a binding takes, whether a file matches its
// history's head, and the live state.

/** The line a partial open shows (`open.*`), most serious first. */
export type PartialLine =
    | { kind: 'damaged' }
    | { kind: 'historyUnreadable' }
    | { kind: 'newerVersion' }
    | { kind: 'mediaBad'; media: MediaKind }
    /** A newer `patch` alone: the open is whole and bound, and says some content may not show. */
    | { kind: 'newerPatch' }

/**
 * Which line a partial open shows, from the reader's report and the level parser's: damage, then
 * history that couldn't be read, then content this build doesn't read, then a bad media entry.
 * A newer major version asked first, so it adds none. A newer `patch` comes last and only when
 * nothing else is wrong, so a partial open never says the same thing twice. Undefined for a
 * whole open.
 */
export const partialLine = (
    report: readonly ReportItem[],
    level: LevelDataReport | undefined,
): PartialLine | undefined => {
    const has = (...reasons: ReportItem['reason'][]) =>
        report.some(({ reason }) => reasons.includes(reason))
    if (has('damaged')) return { kind: 'damaged' }
    if (has('history-unreadable', 'newer-history')) return { kind: 'historyUnreadable' }
    if (
        has('unknown-entry', 'unknown-key', 'invalid-key', 'newer-level', 'newer-minor') ||
        (level && !level.isEmpty)
    )
        return { kind: 'newerVersion' }
    const media = report.find(({ reason }) => reason === 'media-unreadable')?.media
    if (media) return { kind: 'mediaBad', media }
    if (has('newer-version')) return undefined
    if (has('newer-patch')) return { kind: 'newerPatch' }
    return undefined
}

/** A browser's " (n)" or "(n)" suffix on a download's name: "coconut (3).nxsp". */
const SUFFIX = /^(.*?) ?\(\d+\)(\.[^.]*)?$/u

/**
 * The name a binding takes: on a browser without a handle, the name the file's
 * revision recorded when the opened file's is that name with a browser's suffix, so repeated
 * Saves don't drift to "coconut (3) (1).nxsp". With a handle, the handle's name.
 */
export const bindingName = (opened: string, recorded: string | undefined, handle: boolean) => {
    if (handle || !recorded || opened === recorded) return opened
    const match = SUFFIX.exec(opened)
    if (!match) return opened
    return `${match[1] ?? ''}${match[2] ?? ''}` === recorded ? recorded : opened
}

/** A media item's 16-byte hash as hex, from either form. */
export const mediaHash = (form: MediaForm) =>
    form.file === undefined ? form.hash : form.sha256.slice(0, 32)

/** `bgm` as a state's record: its hash, name, size and type, without a duration. */
export const bgmMetaOf = (form: MediaForm): BgmMeta => ({
    ...mediaRefOf(form, bgmFilenameOf(form)),
})

const sameLevelInfo = (a: LevelInfo, b: LevelInfo) =>
    canonical(levelInfoRecord(a)) === canonical(levelInfoRecord(b))

/**
 * A file matches its head: `level.json` matches the head state,
 * `metadata` is the head's level info by the pinned mapping, and `bgm`, when present, names the
 * head's BGM. An absent `bgm` was left out, never a difference.
 */
export const matchesHead = (
    entities: LevelDataEntity[],
    bgmOffset: number,
    project: Pick<ProjectV1, 'editor' | 'metadata' | 'bgm'>,
    head: State,
) => {
    if (!sameLevelInfo(levelInfoOf(project.metadata), head.levelInfo)) return false
    if (project.bgm && mediaHash(project.bgm) !== head.bgm.meta?.hash) return false
    return levelDataMatchesState(entities, bgmOffset, project.editor.defaultGuideColors, head)
}

/**
 * The live state from `level.json` and `project.json` when they win: level info from
 * `metadata` by the pinned mapping, and the BGM from `bgm`, or the head's record as it is when
 * `bgm` is absent (it was left out, not removed).
 */
export const levelState = (
    chart: Chart,
    bgmOffset: number,
    project: Pick<ProjectV1, 'metadata' | 'bgm'> | undefined,
    head: State | undefined,
) => {
    const bgm = project?.bgm ? bgmMetaOf(project.bgm) : head?.bgm.meta
    return createState(chart, bgmOffset, {
        levelInfo: levelInfoOf(project?.metadata),
        ...(bgm ? { bgm } : {}),
    })
}

/** A chain this browser has on the opened file's document, as the open's notice reads it. */
export type EarlierChain = {
    chainId: string
    /** Its latest session. */
    sessionId: string
    /** Its base revision and ancestors. */
    revision?: { id: string; ancestors: readonly string[] }
    /** Bound, with or without a handle. */
    bound?: { handle: boolean }
    /** Its head differs from its file event's state, or a pending journal holds changes. */
    changed: boolean
    /** Its latest session is open in another tab. */
    openElsewhere: boolean
    updatedAt: number
}

/** Whether a chain has changes: in storage, or, for a bound chain, in a pending journal. */
export const changedOf = (
    chain: { changed: boolean; bound?: unknown; sessionId: string },
    journals: ReadonlySet<string>,
) => chain.changed || (!!chain.bound && journals.has(chain.sessionId))

/** What the open says about earlier sessions on its file. */
export type EarlierNotice =
    | { kind: 'unsavedChanges'; chain: EarlierChain; restore: boolean }
    | { kind: 'unsavedEarlier'; chain: EarlierChain }
    | { kind: 'olderVersion'; chain: EarlierChain }

/**
 * Earlier sessions on this file, recognised by revision: unsaved
 * changes on this revision, or on an earlier one (Restore only with a handle, whose Save meets
 * the conflict dialog), or a newer version in Recent Sessions. The most recent such chain.
 */
export const earlierNotice = (
    file: { id: string; ancestors: readonly string[] } | undefined,
    chains: readonly EarlierChain[],
): EarlierNotice | undefined => {
    if (!file) return
    const newest = [...chains]
        .filter((chain) => !chain.openElsewhere)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    const unsaved = newest.find(
        (chain) => chain.bound && chain.changed && chain.revision?.id === file.id,
    )
    if (unsaved) return { kind: 'unsavedChanges', chain: unsaved, restore: true }
    const earlier = newest.find(
        (chain) =>
            chain.bound &&
            chain.changed &&
            chain.revision !== undefined &&
            file.ancestors.includes(chain.revision.id),
    )
    if (earlier?.bound?.handle) return { kind: 'unsavedChanges', chain: earlier, restore: true }
    if (earlier) return { kind: 'unsavedEarlier', chain: earlier }
    const newer = newest.find((chain) => chain.revision?.ancestors.includes(file.id))
    if (newer) return { kind: 'olderVersion', chain: newer }
}
