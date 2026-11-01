import { computed, ref, shallowRef, watch } from 'vue'
import type { GroupId } from './chart/groups'
import { createDisplayClock } from './displayClock'
import { playbackBgm as bgm } from './history/bgm'
import { bpms } from './history/bpms'
import { cullEntities, store } from './history/store'
import {
    createPlayerAudio,
    scheduleActivePlayerAudio,
    type ActivePlayerAudio,
    type PlayerAudio,
} from './playerAudio'
import { shownBeatRanges, spacedTimes, type HideChange } from './playerSections'
import { assetSession, setAudioDecoder, sfxSlots } from './preview/assets'
import { settings } from './settings'
import { createSlideInfoLookup } from './state/entities/slides/lookup'
import { getActiveNoteRole } from './state/entities/slides/semantics'
import { beatToTime, timeToBeat } from './state/integrals/bpms'
import { beatToKey } from './state/store/grid'
import { decodeWithinLimit } from './utils/bgmLimit'
import { entries } from './utils/object'
import { optional } from './utils/optional'

const startupDelay = 0.2
// Keep enough audio queued to survive a slow editor frame without delaying play.
const lookAhead = 0.75
const scheduleInterval = 25
// A running context whose clock stands still this long (ms) has stalled.
const stallTime = 500
// Play stops if the audio clock has not moved this long (ms) after Play. An audition is
// dropped the same way.
const startDeadline = 3000
// A resume() still pending after this long (ms) is taken as one that never settles.
const resumeTimeout = startDeadline

let context = new AudioContext()

const sfxBuffers = {
    normalTap: optional<AudioBuffer>(),
    criticalTap: optional<AudioBuffer>(),
    normalFlick: optional<AudioBuffer>(),
    criticalFlick: optional<AudioBuffer>(),
    normalTrace: optional<AudioBuffer>(),
    criticalTrace: optional<AudioBuffer>(),
    normalTick: optional<AudioBuffer>(),
    criticalTick: optional<AudioBuffer>(),
    normalActive: optional<AudioBuffer>(),
    criticalActive: optional<AudioBuffer>(),
}

const state = shallowRef<{
    speed: number
    bgmTime: number
    // Audio time at which bgmTime begins, including any initial preroll.
    contextTime: number

    scheduledUntil?: number
    bgmNodes: Set<PlayerAudio>
    sfxNodes: Set<PlayerAudio>
    // Chart time of the last scheduled play of each clip, for spacing.
    lastSfx: Partial<Record<string, number>>
    actives: {
        normalActive: Set<ActivePlayerAudio>
        criticalActive: Set<ActivePlayerAudio>
    }
}>()
export const isPlaying = computed(() => !!state.value)

export const isBgmEnabled = ref(true)
watch(isBgmEnabled, () => {
    if (!state.value) return

    const value = isBgmEnabled.value ? settings.playBgmVolume : 0

    for (const audio of state.value.bgmNodes) {
        audio.setVolume(value)
    }
})

export const isSfxEnabled = ref(true)
watch(isSfxEnabled, () => {
    if (!state.value) return

    const value = isSfxEnabled.value ? settings.playSfxVolume : 0

    for (const audio of state.value.sfxNodes) {
        audio.setVolume(value)
    }

    for (const actives of Object.values(state.value.actives)) {
        for (const audio of actives) {
            audio.setVolume(value)
        }
    }
})

let preview: PlayerAudio | undefined
let scheduler: ReturnType<typeof setInterval> | undefined
let startCheck: ReturnType<typeof setTimeout> | undefined
let areSfxReady = false
// The clock when the context was found stuck: Play replaces it while its clock still reads this.
let stuckAt: number | undefined
// The resume() calls still pending on the context, and when the first of them was made.
let pendingResumes = 0
let resumeSince: number | undefined
// The clock's last reading while playing, and when it changed.
let clockReading: { time: number; at: number } | undefined
const getSlideInfoLookup = createSlideInfoLookup()

const sfxDistance = 0.02

// Hide-notes changes per group, rebuilt only when time scales change.
let hideChanges: { grid: unknown; byGroup: Map<GroupId, HideChange[]> } | undefined
const getHideChanges = (groupId: GroupId) => {
    const grid = store.value.grid.timeScale
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
    return hideChanges.byGroup.get(groupId) ?? []
}

const scheduleAudio = () => {
    if (!state.value || !areSfxReady) return

    // Scan only new, still playable audio time. The audio clock freezes during
    // suspension, so neither the cursor nor scheduling can run ahead of the BGM.
    const now = context.currentTime
    const startTime = Math.max(
        state.value.contextTime,
        state.value.scheduledUntil ?? state.value.contextTime,
        now,
    )
    const endTime = Math.max(startTime, now + lookAhead)
    if (startTime === endTime) return
    const isCatchingUp =
        state.value.scheduledUntil === undefined || startTime > state.value.scheduledUntil
    const beats = {
        min: timeToBeat(
            bpms.value,
            (startTime - state.value.contextTime) * state.value.speed + state.value.bgmTime,
        ),
        max: timeToBeat(
            bpms.value,
            (endTime - state.value.contextTime) * state.value.speed + state.value.bgmTime,
        ),
    }

    const keys = {
        min: beatToKey(beats.min),
        max: beatToKey(beats.max),
    }

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

    for (const entity of cullEntities('note', keys.min, keys.max)) {
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

        const infos = store.value.slides.info.get(entity.slideId)
        if (!infos) throw new Error('Unexpected missing infos')

        const info = getSlideInfoLookup(infos).get(entity)
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
        if (!sfxBuffers[type]) continue

        // Sonolus skips a clip played within 20 ms of the same clip.
        const times = spacedTimes(
            [...beats].map((beat) => beatToTime(bpms.value, beat)),
            sfxDistance,
            state.value.lastSfx[type],
        )
        const last = times.at(-1)
        if (last !== undefined) state.value.lastSfx[type] = last

        for (const time of times) {
            const when = (time - state.value.bgmTime) / state.value.speed + state.value.contextTime
            if (when < context.currentTime) continue

            schedule(
                state.value.sfxNodes,
                sfxBuffers[type],
                isSfxEnabled.value ? settings.playSfxVolume : 0,
                when,
            )
        }
    }

    const activeTargets = {
        normalActive: Array<[number, number]>(),
        criticalActive: Array<[number, number]>(),
    }

    for (const entity of cullEntities('connector', keys.min, keys.max)) {
        if (entity.head.beat >= beats.max || entity.tail.beat <= beats.min) continue
        if (entity.segmentHead.connectorType !== 'active') continue

        // The hold sound pauses while the segment head's group hides notes.
        // Cull each shown piece by its own start: a piece beginning when hiding
        // ends falls in a later window than the connector's head.
        const pieces = shownBeatRanges(
            getHideChanges(entity.segmentHead.groupId),
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
        if (!sfxBuffers[type]) continue

        for (const [start, end] of pieces.sort((a, b) => a[0] - b[0])) {
            scheduleActivePlayerAudio(
                context,
                state.value.actives[type],
                sfxBuffers[type],
                start,
                end,
                isSfxEnabled.value ? settings.playSfxVolume : 0,
                (beatToTime(bpms.value, start) - state.value.bgmTime) / state.value.speed +
                    state.value.contextTime,
                (beatToTime(bpms.value, end) - state.value.bgmTime) / state.value.speed +
                    state.value.contextTime,
            )
        }
    }

    state.value.scheduledUntil = endTime
}

const clearScheduler = () => {
    clearInterval(scheduler)
    scheduler = undefined
}

// Marks a running context for replacement at the next Play when its clock stands still,
// for example after a route change.
const checkClock = () => {
    const time = context.currentTime
    const at = performance.now()
    if (clockReading?.time !== time || document.visibilityState !== 'visible')
        clockReading = { time, at }
    else if (at - clockReading.at >= stallTime) stuckAt = time
}

const updateScheduler = () => {
    clearScheduler()
    clockReading = undefined
    if (!state.value || context.state !== 'running') return
    scheduleAudio()
    // Audio scheduling must not depend on whether the preview renders a frame.
    scheduler = setInterval(() => {
        checkClock()
        scheduleAudio()
    }, scheduleInterval)
}

context.addEventListener('statechange', updateScheduler)

export const getPlayerTime = () => {
    if (!state.value) return
    return (
        Math.max(0, context.currentTime - state.value.contextTime) * state.value.speed +
        state.value.bgmTime
    )
}

// Drawing only; pausing and scheduling read the audio clock.
const displayClock = createDisplayClock()
let displayClockState: typeof state.value

export const getPlayerDisplayTime = () => {
    const current = state.value
    if (!current) return
    if (displayClockState !== current) {
        displayClockState = current
        displayClock.reset()
    }
    const audioTime = displayClock.read(
        context.currentTime,
        performance.now() / 1000,
        context.state === 'running',
    )
    return Math.max(0, audioTime - current.contextTime) * current.speed + current.bgmTime
}

// Decodes in flight on each context: a replaced context is closed only once its decodes settle.
const decodes = new Map<AudioContext, number>()

const decode = (data: ArrayBuffer) => {
    const decoding = context
    decodes.set(decoding, (decodes.get(decoding) ?? 0) + 1)
    return decoding.decodeAudioData(data).finally(() => {
        const left = (decodes.get(decoding) ?? 1) - 1
        if (left) decodes.set(decoding, left)
        else decodes.delete(decoding)
        if (!left && decoding !== context) closeContext(decoding)
    })
}

/** Decodes audio bytes, within the BGM length limit (`decodeWithinLimit`). */
export const loadBgm = (data: ArrayBuffer) => decodeWithinLimit(data, decode)

/**
 * `onFailure` runs when this start fails, because the audio clock did not move or resume()
 * was rejected.
 */
export const startPlayer = (
    bgmTime: number,
    speed: number,
    onFailure: () => void,
    delay = startupDelay,
) => {
    setAudioSession()
    // Inside the Play gesture, where a new context can start.
    const replace = needsNewContext()
    stopPlayback(replace)
    if (replace) replaceContext()

    const startTime = context.currentTime
    const contextTime = startTime + delay

    state.value = {
        speed,
        bgmTime,
        contextTime,

        bgmNodes: new Set(),
        sfxNodes: new Set(),
        lastSfx: {},
        actives: {
            normalActive: new Set(),
            criticalActive: new Set(),
        },
    }
    const current = state.value

    const fail = () => {
        stopPlayback(true)
        onFailure()
    }
    resumeContext(() => {
        if (state.value === current) fail()
    })
    stopPreviewPlayer()

    if (bgm.value.buffer)
        schedule(
            state.value.bgmNodes,
            bgm.value.buffer,
            isBgmEnabled.value ? settings.playBgmVolume : 0,
            contextTime,
            bgmTime + bgm.value.offset,
            speed,
            true,
        )

    // Queue the first window even if resume is pending; native audio starts and
    // the cursor share the same suspended clock, and stop cancels these sources.
    scheduleAudio()
    updateScheduler()

    // If the clock has not moved, stop. The next Play replaces the context if its clock still
    // has not.
    startCheck = setTimeout(() => {
        startCheck = undefined
        if (state.value !== current || context.currentTime > startTime) return
        stuckAt = startTime
        fail()
    }, startDeadline)
}

// `immediately` skips the fade, because a fade on a clock that stands still never ends.
const stopPlayback = (immediately: boolean) => {
    clearScheduler()
    clearTimeout(startCheck)
    startCheck = undefined
    if (!state.value) return

    const stop = (audio: PlayerAudio) => {
        if (immediately) audio.stop()
        else audio.fadeOut()
    }
    for (const audio of state.value.bgmNodes) {
        stop(audio)
    }
    for (const audio of state.value.sfxNodes) {
        stop(audio)
    }

    for (const actives of Object.values(state.value.actives)) {
        for (const audio of actives) {
            stop(audio)
        }
    }

    state.value = undefined
}

export const stopPlayer = () => {
    stopPlayback(false)
}

export const previewPlayer = (bgmTime: number) => {
    const duration = settings.playPreviewDuration / 1000
    if (duration <= 0) return

    setAudioSession()
    stopPreviewPlayer()
    const audio = startPreview(bgmTime, duration)
    resumeContext(() => {
        if (audio && preview === audio) stopPreviewPlayer()
    })
}

const startPreview = (bgmTime: number, duration: number) => {
    if (!bgm.value.buffer) return

    const offset = bgmTime + bgm.value.offset
    if (offset < 0) return

    const audio = createPlayerAudio(
        context,
        { buffer: bgm.value.buffer },
        settings.playBgmVolume,
        () => {
            if (preview === audio) preview = undefined
        },
    )
    preview = audio

    const started = context
    const time = started.currentTime
    audio.envelope(time, duration)
    audio.start(time, offset, duration)
    // An audition must not play when a context that could not start runs much later by itself.
    setTimeout(() => {
        if (started !== context || started.currentTime > time) return
        stuckAt = time
        audio.stop()
    }, startDeadline)
    return audio
}

export const stopPreviewPlayer = () => {
    preview?.fadeOut()
    preview = undefined
}

// On iOS, play through the silent switch (Audio Session API, Safari 16.4+).
const setAudioSession = () => {
    const { audioSession } = navigator as Navigator & { audioSession?: { type: string } }
    if (audioSession) audioSession.type = 'playback'
}

// Retry resume() for each Play and audition while the context is not running. WebKit can
// leave earlier calls pending.
const resumeContext = (onFailure: () => void) => {
    if (context.state === 'running') return
    const resumed = context
    pendingResumes++
    resumeSince ??= performance.now()
    const settle = () => {
        if (resumed !== context) return
        if (--pendingResumes === 0) resumeSince = undefined
    }
    void resumed.resume().then(settle, () => {
        settle()
        if (resumed === context && resumed.state !== 'running') onFailure()
    })
}

// In WebKit, an interrupted context, or one whose resume() has not settled, may not start again.
const needsNewContext = () =>
    context.currentTime === stuckAt ||
    context.state === 'interrupted' ||
    context.state === 'closed' ||
    (context.state !== 'running' &&
        resumeSince !== undefined &&
        performance.now() - resumeSince > resumeTimeout)

// close() rejects on a context that is already closed.
const closeContext = (closing: AudioContext) => {
    void closing.close().catch(() => undefined)
}

// Decoded audio carries over, as an AudioBuffer belongs to no context. Sources are made for
// each start.
const replaceContext = () => {
    let next: AudioContext
    try {
        next = new AudioContext()
    } catch {
        // Keep the old context; the next Play tries again.
        return
    }
    preview?.stop()
    preview = undefined
    context.removeEventListener('statechange', updateScheduler)
    if (!decodes.has(context)) closeContext(context)
    context = next
    context.addEventListener('statechange', updateScheduler)
    stuckAt = undefined
    pendingResumes = 0
    resumeSince = undefined
}

// When the page is shown again, marks a running context whose clock stands still, so the
// next Play replaces it.
let recheckTimer: ReturnType<typeof setTimeout> | undefined
const recheckContext = () => {
    clearTimeout(recheckTimer)
    if (document.visibilityState !== 'visible' || context.state !== 'running') return
    const checked = context
    const time = checked.currentTime
    recheckTimer = setTimeout(() => {
        if (
            checked === context &&
            checked.state === 'running' &&
            checked.currentTime === time &&
            document.visibilityState === 'visible'
        )
            stuckAt = time
    }, stallTime)
}
document.addEventListener('visibilitychange', recheckContext)
window.addEventListener('pageshow', recheckContext)

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

// The sound effects the preview and playback use; a choice change loads them again in place.
const loadSfx = () => {
    setAudioDecoder(decode)
    watch(
        assetSession.slots.effect,
        ({ state, value }) => {
            if (value) for (const slot of sfxSlots) sfxBuffers[slot] = value.buffers[slot]
            if (state === 'ready' || state === 'failed') areSfxReady = true
        },
        { immediate: true },
    )
    assetSession.ensure('effect')
}

loadSfx()

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        stopPlayer()
        stopPreviewPlayer()
        clearTimeout(recheckTimer)
        document.removeEventListener('visibilitychange', recheckContext)
        window.removeEventListener('pageshow', recheckContext)
        context.removeEventListener('statechange', updateScheduler)
        void context.close()
    })
}
