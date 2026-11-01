import { computed, ref, shallowRef, watch } from 'vue'
import { createDisplayClock } from './displayClock'
import { playbackBgm as bgm } from './history/bgm'
import { bpms } from './history/bpms'
import { store } from './history/store'
import { createPlayerAudio, type PlayerAudio } from './playerAudio'
import { createSoundScheduler } from './playerSoundScheduler'
import { assetSession, setAudioDecoder, sfxSlots } from './preview/assets'
import { settings } from './settings'
import type { State } from './state'
import type { Bgm } from './state/bgm'
import { decodeWithinLimit } from './utils/bgmLimit'
import { optional } from './utils/optional'

export const startupDelay = 0.2
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
    token: symbol
    speed: number
    bgmTime: number
    // Audio time at which bgmTime begins, including any initial preroll.
    contextTime: number

    sounds: ReturnType<typeof createSoundScheduler>
}>()
export const isPlaying = computed(() => !!state.value)

export const isBgmEnabled = ref(true)
watch(isBgmEnabled, () => {
    if (!state.value) return

    const value = isBgmEnabled.value ? settings.playBgmVolume : 0

    state.value.sounds.setBgmVolume(value)
})

export const isSfxEnabled = ref(true)
watch(isSfxEnabled, () => {
    if (!state.value) return

    const value = isSfxEnabled.value ? settings.playSfxVolume : 0

    state.value.sounds.setSfxVolume(value)
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
const scheduleAudio = () => {
    if (!state.value || !areSfxReady) return
    state.value.sounds.schedule()
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

    const token = Symbol()
    state.value = {
        token,
        speed,
        bgmTime,
        contextTime,

        sounds: createSoundScheduler({
            context,
            source: () => ({ store: store.value, bpms: bpms.value }),
            buffers: { sfx: sfxBuffers, bgm: bgm.value },
            volumes: {
                bgm: () => (isBgmEnabled.value ? settings.playBgmVolume : 0),
                sfx: () => (isSfxEnabled.value ? settings.playSfxVolume : 0),
            },
            start: { time: bgmTime, contextTime, speed },
        }),
    }
    const fail = () => {
        stopPlayback(true)
        onFailure()
    }
    resumeContext(() => {
        if (state.value?.token === token) fail()
    })
    stopPreviewPlayer()

    state.value.sounds.startBgm()

    // Queue the first window even if resume is pending; native audio starts and
    // the cursor share the same suspended clock, and stop cancels these sources.
    scheduleAudio()
    updateScheduler()

    // If the clock has not moved, stop. The next Play replaces the context if its clock still
    // has not.
    startCheck = setTimeout(() => {
        startCheck = undefined
        if (state.value?.token !== token || context.currentTime > startTime) return
        stuckAt = startTime
        fail()
    }, startDeadline)
}

// `immediately` skips the fade, because a fade on a clock that stands still never ends.
const stopPlayback = (immediately: boolean) => {
    displayClockState = undefined
    clearScheduler()
    clearTimeout(startCheck)
    startCheck = undefined
    if (!state.value) return

    state.value.sounds.stop(immediately)

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

/** The sound effects as loaded now, for an export's mix. */
export const loadedSfx = (): Partial<Record<keyof typeof sfxBuffers, AudioBuffer>> =>
    Object.fromEntries(Object.entries(sfxBuffers).filter(([, buffer]) => buffer))

/**
 * Plays a fixed chart from `time` with its own BGM and volumes, on Play's context, for a dialog
 * that previews a clip. The editor's playback stops, and its cursor is left alone.
 */
export const startClipPlayer = (options: {
    time: number
    source: Pick<State, 'store' | 'bpms'>
    bgm: Bgm
    volumes: { bgm: number; sfx: number }
    onFailure: () => void
}) => {
    setAudioSession()
    const replace = needsNewContext()
    stopPlayback(replace)
    stopPreviewPlayer()
    if (replace) replaceContext()
    const started = context
    const startTime = started.currentTime
    const contextTime = startTime + startupDelay
    const sounds = createSoundScheduler({
        context: started,
        source: () => options.source,
        buffers: { sfx: sfxBuffers, bgm: options.bgm },
        volumes: { bgm: () => options.volumes.bgm, sfx: () => options.volumes.sfx },
        start: { time: options.time, contextTime, speed: 1 },
    })
    let stopped = false
    const clock = createDisplayClock()
    const tick = () => {
        if (started.state === 'running' && areSfxReady) sounds.schedule()
    }
    const interval = setInterval(tick, scheduleInterval)
    const check = setTimeout(() => {
        if (stopped || started.currentTime > startTime) return
        stuckAt = startTime
        fail()
    }, startDeadline)
    const stop = (immediately = false) => {
        if (stopped) return
        stopped = true
        clearInterval(interval)
        clearTimeout(check)
        sounds.stop(immediately)
    }
    const fail = () => {
        stop(true)
        options.onFailure()
    }
    resumeContext(() => {
        if (!stopped) fail()
    })
    sounds.startBgm()
    if (areSfxReady) sounds.schedule()
    return {
        /** The chart time now playing, smoothed for drawing. */
        time: () =>
            Math.max(
                0,
                clock.read(
                    started.currentTime,
                    performance.now() / 1000,
                    started.state === 'running',
                ) - contextTime,
            ) + options.time,
        stop,
    }
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

/** Whether the current sound effects have loaded, or failed to: an export captures them then. */
export const sfxSettled = ref(false)

// The sound effects the preview and playback use; a choice change loads them again in place.
const loadSfx = () => {
    setAudioDecoder(decode)
    watch(
        assetSession.slots.effect,
        ({ state, value }) => {
            if (value) for (const slot of sfxSlots) sfxBuffers[slot] = value.buffers[slot]
            if (state === 'ready' || state === 'failed') areSfxReady = true
            sfxSettled.value = state === 'ready' || state === 'failed'
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
