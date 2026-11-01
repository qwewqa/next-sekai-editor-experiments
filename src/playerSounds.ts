import type { GroupId } from './chart/groups'
import { shownBeatRanges, spacedTimes, type HideChange } from './playerSections'
import type { ConnectorEntity } from './state/entities/slides/connector'
import type { NoteEntity } from './state/entities/slides/note'
import { getActiveNoteRole, type SlideNoteInfo } from './state/entities/slides/semantics'
import { beatToTime, timeToBeat, type BpmIntegral } from './state/integrals/bpms'
import { entries } from './utils/object'

export type HitClip =
    | 'normalTap'
    | 'criticalTap'
    | 'normalFlick'
    | 'criticalFlick'
    | 'normalTrace'
    | 'criticalTrace'
    | 'normalTick'
    | 'criticalTick'
export type HoldClip = 'normalActive' | 'criticalActive'
export type SoundClip = HitClip | HoldClip
export type SoundSource = {
    notes: Iterable<NoteEntity>
    connectors: Iterable<ConnectorEntity>
    getInfo: (note: NoteEntity) => SlideNoteInfo | undefined
    getHideChanges: (group: GroupId) => readonly HideChange[]
}
export type SoundPlanState = { until?: number; lastSfx: Partial<Record<HitClip, number>> }
export type SoundEvent =
    | { type: 'hit'; clip: HitClip; time: number }
    | {
          type: 'hold'
          clip: HoldClip
          time: number
          endTime: number
          startBeat: number
          endBeat: number
      }

// Times and spacing are in chart seconds, independent of playback speed.
export const planSounds = (
    source: SoundSource,
    bpms: BpmIntegral[],
    clips: Partial<Record<SoundClip, boolean>>,
    window: { from: number; to: number },
    previous: SoundPlanState,
): { events: SoundEvent[]; state: SoundPlanState } => {
    const hits = planHits(source, bpms, clips, window, previous)
    return {
        events: [...hits.events, ...planHolds(source, bpms, clips, window, previous)],
        state: hits.state,
    }
}

export const planHits = (
    source: Pick<SoundSource, 'notes' | 'getInfo'>,
    bpms: BpmIntegral[],
    clips: Partial<Record<SoundClip, boolean>>,
    window: { from: number; to: number },
    previous: SoundPlanState,
): { events: Extract<SoundEvent, { type: 'hit' }>[]; state: SoundPlanState } => {
    const beats = { min: timeToBeat(bpms, window.from), max: timeToBeat(bpms, window.to) }
    const lastSfx = { ...previous.lastSfx }
    const events: Extract<SoundEvent, { type: 'hit' }>[] = []
    const sfxDistance = 0.02

    const targets = {
        normalTap: new Set<number>(),
        criticalTap: new Set<number>(),
        normalFlick: new Set<number>(),
        criticalFlick: new Set<number>(),
        normalTrace: new Set<number>(),
        criticalTrace: new Set<number>(),
        normalTick: new Set<number>(),
        criticalTick: new Set<number>(),
    }

    for (const entity of source.notes) {
        if (entity.beat < beats.min || entity.beat >= beats.max) continue

        if (entity.isFake) continue

        // Anchors are unscored, so the engine never plays them, even with an
        // explicit sound.
        if (entity.noteType === 'anchor') continue

        if (entity.sfx === 'none') continue
        if (entity.sfx === 'damage') continue

        if (entity.sfx !== 'default') {
            targets[entity.sfx].add(entity.beat)
            continue
        }

        if (entity.noteType === 'damage') continue

        const info = source.getInfo(entity)
        if (!info) throw new Error('Unexpected missing info')

        const activeRole = getActiveNoteRole(info)
        const isFlick = info.note.flickDirection !== 'none'

        if (entity.noteType === 'trace') {
            if (isFlick) {
                if (entity.isCritical) {
                    targets.criticalFlick.add(entity.beat)
                } else {
                    targets.normalFlick.add(entity.beat)
                }
            } else {
                if (entity.isCritical) {
                    targets.criticalTrace.add(entity.beat)
                } else {
                    targets.normalTrace.add(entity.beat)
                }
            }
        } else if (entity.noteType === 'forceTick') {
            if (entity.isCritical) {
                targets.criticalTick.add(entity.beat)
            } else {
                targets.normalTick.add(entity.beat)
            }
        } else if (activeRole === 'single') {
            if (isFlick) {
                if (entity.isCritical) {
                    targets.criticalFlick.add(entity.beat)
                } else {
                    targets.normalFlick.add(entity.beat)
                }
            } else {
                if (entity.isCritical) {
                    targets.criticalTap.add(entity.beat)
                } else {
                    targets.normalTap.add(entity.beat)
                }
            }
        } else if (activeRole === 'head' || activeRole === 'tail') {
            if (isFlick) {
                if (entity.isCritical) {
                    targets.criticalFlick.add(entity.beat)
                } else {
                    targets.normalFlick.add(entity.beat)
                }
            } else {
                targets.normalTap.add(entity.beat)
            }
        } else if (entity.noteType === 'default') {
            if (entity.isCritical) {
                targets.criticalTick.add(entity.beat)
            } else {
                targets.normalTick.add(entity.beat)
            }
        } else {
            if (isFlick) {
                if (entity.isCritical) {
                    targets.criticalFlick.add(entity.beat)
                } else {
                    targets.normalFlick.add(entity.beat)
                }
            } else {
                if (entity.isCritical) {
                    targets.criticalTap.add(entity.beat)
                } else {
                    targets.normalTap.add(entity.beat)
                }
            }
        }
    }

    for (const [type, beats] of entries(targets)) {
        if (!clips[type]) continue

        // Sonolus skips a clip played within 20 ms of the same clip.
        const times = spacedTimes(
            [...beats].map((beat) => beatToTime(bpms, beat)),
            sfxDistance,
            lastSfx[type],
        )
        const last = times.at(-1)
        if (last !== undefined) lastSfx[type] = last

        for (const time of times) events.push({ type: 'hit', clip: type, time })
    }

    return { events, state: { until: window.to, lastSfx } }
}

export const planHolds = (
    source: Pick<SoundSource, 'connectors' | 'getHideChanges'>,
    bpms: BpmIntegral[],
    clips: Partial<Record<SoundClip, boolean>>,
    window: { from: number; to: number },
    previous: SoundPlanState,
): Extract<SoundEvent, { type: 'hold' }>[] => {
    const beats = { min: timeToBeat(bpms, window.from), max: timeToBeat(bpms, window.to) }
    const isCatchingUp = previous.until === undefined || window.from > previous.until
    const events: Extract<SoundEvent, { type: 'hold' }>[] = []
    const activeTargets = {
        normalActive: Array<[number, number]>(),
        criticalActive: Array<[number, number]>(),
    }

    for (const entity of source.connectors) {
        if (entity.head.beat >= beats.max || entity.tail.beat <= beats.min) continue
        if (entity.segmentHead.connectorType !== 'active') continue

        // The hold sound pauses while the segment head's group hides notes.
        // Cull each shown piece by its own start: a piece beginning when hiding
        // ends falls in a later window than the connector's head.
        const pieces = shownBeatRanges(
            source.getHideChanges(entity.segmentHead.groupId),
            entity.head.beat,
            entity.tail.beat,
        )
        for (const piece of pieces) {
            if (piece[0] >= beats.max || piece[1] <= beats.min) continue
            if (piece[0] < beats.min && !isCatchingUp) continue

            if (entity.segmentHead.connectorActiveIsCritical) {
                activeTargets.criticalActive.push(piece)
            } else {
                activeTargets.normalActive.push(piece)
            }
        }
    }

    for (const [type, pieces] of entries(activeTargets)) {
        if (!clips[type]) continue

        for (const [start, end] of pieces.sort((a, b) => a[0] - b[0])) {
            events.push({
                type: 'hold',
                clip: type,
                startBeat: start,
                endBeat: end,
                time: beatToTime(bpms, start),
                endTime: beatToTime(bpms, end),
            })
        }
    }

    return events
}

export type ActiveSound = { endBeat: number; endTime: number }
export type ActiveSoundPlan<T> = {
    expired: T[]
    next: { type: 'skip' } | { type: 'extend'; active: T } | { type: 'start'; time: number }
}

// An ended callback can still be queued after its source has stopped. Such a voice cannot restart.
export const planActiveSound = <T extends ActiveSound>(
    actives: Iterable<T>,
    startBeat: number,
    endBeat: number,
    whenStart: number,
    whenStop: number,
    now: number,
): ActiveSoundPlan<T> => {
    const expired: T[] = []
    if (whenStop <= now) return { expired, next: { type: 'skip' } }
    for (const active of actives) {
        if (active.endTime <= now) {
            expired.push(active)
            continue
        }
        if (active.endBeat < startBeat) continue
        return {
            expired,
            next: endBeat <= active.endBeat ? { type: 'skip' } : { type: 'extend', active },
        }
    }
    return { expired, next: { type: 'start', time: Math.max(whenStart, now) } }
}
