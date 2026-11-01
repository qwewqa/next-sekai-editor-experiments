import type { GroupId } from './chart/groups'
import {
    createPlayerAudio,
    scheduleActivePlayerAudio,
    type ActivePlayerAudio,
    type PlayerAudio,
} from './playerAudio'
import type { HideChange } from './playerSections'
import { planSounds, type SoundClip, type SoundPlanState } from './playerSounds'
import type { State } from './state'
import type { Bgm } from './state/bgm'
import { createSlideInfoLookup } from './state/entities/slides/lookup'
import { timeToBeat } from './state/integrals/bpms'
import { beatToKey, cullGrids } from './state/store/grid'

// Keep enough audio queued to survive a slow editor frame without delaying play.
const lookAhead = 0.75

export const createSoundScheduler = ({
    context,
    source,
    buffers,
    volumes,
    start,
}: {
    context: AudioContext
    source: () => Pick<State, 'store' | 'bpms'>
    buffers: { sfx: Partial<Record<SoundClip, AudioBuffer>>; bgm: Bgm }
    volumes: { bgm: () => number; sfx: () => number }
    start: { time: number; contextTime: number; speed: number }
}) => {
    let scheduledUntil: number | undefined
    let continuation: SoundPlanState = { lastSfx: {} }
    const bgmNodes = new Set<PlayerAudio>()
    const sfxNodes = new Set<PlayerAudio>()
    const actives = {
        normalActive: new Set<ActivePlayerAudio>(),
        criticalActive: new Set<ActivePlayerAudio>(),
    }
    const getSlideInfo = createSlideInfoLookup()
    let hideChanges: { grid: unknown; byGroup: Map<GroupId, HideChange[]> } | undefined
    const chartTime = (time: number) => (time - start.contextTime) * start.speed + start.time
    const audioTime = (time: number) => (time - start.time) / start.speed + start.contextTime

    const schedule = (
        nodes: Set<PlayerAudio>,
        buffer: AudioBuffer,
        volume: number,
        when: number,
        offset = 0,
        speed = 1,
        fadeIn = false,
    ) => {
        const audio = createPlayerAudio(context, { buffer, playbackRate: speed }, volume, () =>
            nodes.delete(audio),
        )
        nodes.add(audio)
        const startTime = offset < 0 ? when - offset / speed : when
        if (fadeIn) audio.fadeIn(startTime)
        audio.start(startTime, Math.max(0, offset))
    }

    return {
        startBgm() {
            if (buffers.bgm.buffer)
                schedule(
                    bgmNodes,
                    buffers.bgm.buffer,
                    volumes.bgm(),
                    start.contextTime,
                    start.time + buffers.bgm.offset,
                    start.speed,
                    true,
                )
        },
        schedule() {
            const now = context.currentTime
            const from = Math.max(start.contextTime, scheduledUntil ?? start.contextTime, now)
            const to = Math.max(from, now + lookAhead)
            if (from === to) return
            const { store, bpms } = source()
            const grid = store.grid.timeScale
            if (hideChanges?.grid !== grid) {
                const byGroup = new Map<GroupId, HideChange[]>()
                for (const timeScale of new Set([...grid.values()].flatMap((set) => [...set]))) {
                    let changes = byGroup.get(timeScale.groupId)
                    if (!changes) byGroup.set(timeScale.groupId, (changes = []))
                    changes.push({ beat: timeScale.beat, hideNotes: timeScale.hideNotes })
                }
                for (const changes of byGroup.values()) changes.sort((a, b) => a.beat - b.beat)
                hideChanges = { grid, byGroup }
            }
            const min = beatToKey(timeToBeat(bpms, chartTime(from)))
            const max = beatToKey(timeToBeat(bpms, chartTime(to)))
            const changesByGroup = hideChanges.byGroup
            const plan = planSounds(
                {
                    notes: cullGrids([store.grid.note], min, max),
                    connectors: cullGrids([store.grid.connector], min, max),
                    getInfo: (note) => {
                        const infos = store.slides.info.get(note.slideId)
                        if (!infos) throw new Error('Unexpected missing infos')
                        return getSlideInfo(infos).get(note)
                    },
                    getHideChanges: (group) => changesByGroup.get(group) ?? [],
                },
                bpms,
                Object.fromEntries(
                    Object.entries(buffers.sfx).map(([clip, buffer]) => [clip, !!buffer]),
                ),
                { from: chartTime(from), to: chartTime(to) },
                continuation,
            )
            continuation = plan.state
            for (const event of plan.events) {
                const buffer = buffers.sfx[event.clip]
                if (!buffer) continue
                const when = audioTime(event.time)
                if (event.type === 'hit') {
                    // The clock can advance during planning. Do not replay a hit that has passed.
                    if (when < context.currentTime) continue
                    schedule(sfxNodes, buffer, volumes.sfx(), when)
                } else {
                    scheduleActivePlayerAudio(
                        context,
                        actives[event.clip],
                        buffer,
                        event.startBeat,
                        event.endBeat,
                        volumes.sfx(),
                        when,
                        audioTime(event.endTime),
                    )
                }
            }
            scheduledUntil = to
        },
        setBgmVolume(value: number) {
            for (const audio of bgmNodes) audio.setVolume(value)
        },
        setSfxVolume(value: number) {
            for (const audio of sfxNodes) audio.setVolume(value)
            for (const group of Object.values(actives))
                for (const audio of group) audio.setVolume(value)
        },
        stop(immediately: boolean) {
            for (const nodes of [bgmNodes, sfxNodes, ...Object.values(actives)]) {
                for (const audio of nodes) {
                    if (immediately) audio.stop()
                    else audio.fadeOut()
                }
            }
        },
    }
}
