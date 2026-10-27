import { shallowReactive, watch } from 'vue'
import { markStartup } from '../analytics/tally'
import { cancelSavePage } from '../editor/controls/saveChord'
import { testKeysOpen } from '../platform/testKeys'
import { errorMessage } from '../utils/error'

// The startup gate: until the session is open, the editor refuses input, so
// nothing typed into a default chart is lost to the open that replaces it. This is its state and
// its input guard; StartupGate.vue draws it. It is imported ahead of the app (`launch.ts`), so
// input is swallowed from the first frame.

/** After this long, the gate adds the slow text with Start Blank and Open in Safe Mode. */
export const SLOW_MS = 10_000
/** The spinner and the text wait this long, so a quick open shows nothing. */
export const SPINNER_DELAY_MS = 150

/** The test flags: a JSON object in this key (a tab's sessionStorage first, then localStorage). */
export const STARTUP_TEST_KEY = 'nse.test.startup'

type StartupFlags = {
    /** Startup stays open until `window.nseStartupRelease()` is called. */
    hold?: boolean
    /** Startup fails with this text, after the real startup has run. */
    fail?: string
    /** The slow text comes after this many milliseconds instead of 10 s. */
    slowMs?: number
}

declare global {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Window {
        /** Ends a startup held by the `hold` test flag. */
        nseStartupRelease?: () => void
    }
}

export type StartupPhase = 'opening' | 'error' | 'done'

/**
 * The error state's Export Raw Data: its label, in the app's language, and what it does.
 * `run` resolves to a line to show under the buttons, when the export did not go through whole.
 */
export type RawExport = { label: () => string; run: () => Promise<string | undefined> }

type GateState = {
    phase: StartupPhase
    /** The session being opened, once known: "Opening "Coconut (Master)"…". */
    name: string | undefined
    /** Startup took longer than SLOW_MS. */
    slow: boolean
    /** The open of a stored session did not finish last time: asking what to do. */
    asking: { name: string | undefined } | undefined
    /** The failed startup's own text. */
    error: string
    /** Export Raw Data on the error state, registered by `setRawExport`; undefined until then. */
    rawExport: RawExport | undefined
    /** Its export is running: the button waits, so a second press starts no second download. */
    rawExportRunning: boolean
    /** What the last Export Raw Data press says, if it did not go through whole. */
    rawExportNote: string | undefined
}

export const startupGate = shallowReactive<GateState>({
    phase: 'opening',
    name: undefined,
    slow: false,
    asking: undefined,
    error: '',
    rawExport: undefined,
    rawExportRunning: false,
    rawExportNote: undefined,
})

const readFlags = (): StartupFlags => {
    try {
        const text = testKeysOpen
            ? (sessionStorage.getItem(STARTUP_TEST_KEY) ?? localStorage.getItem(STARTUP_TEST_KEY))
            : null
        const parsed: unknown = text ? JSON.parse(text) : undefined
        return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
        return {}
    }
}

let slowTimer: ReturnType<typeof setTimeout> | undefined
let element: HTMLElement | undefined

/** Events that carry input to the editor. */
const POINTER_EVENTS = [
    'pointerdown',
    'pointerup',
    'mousedown',
    'mouseup',
    'click',
    'dblclick',
    'auxclick',
    'contextmenu',
    'touchstart',
    'touchend',
    'wheel',
    'paste',
    'cut',
    'copy',
    'drop',
    'dragover',
    'dragenter',
] as const
const KEY_EVENTS = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input'] as const

const inGate = (target: EventTarget | null) =>
    element !== undefined && target instanceof Node && element.contains(target)

// Capture on window, registered first, so no editor listener sees the event. A key's default
// action stays: Tab moves focus to the gate's buttons, Enter and Space press the focused one,
// and the browser's own shortcuts (a reload) still work.
const swallow = (event: Event) => {
    if (startupGate.phase === 'done') return
    if (!(KEY_EVENTS as readonly string[]).includes(event.type) && inGate(event.target)) return
    // The editor's own cancel of Save Page never runs once the event stops here.
    if (event instanceof KeyboardEvent) cancelSavePage(event)
    event.stopImmediatePropagation()
}

// A shared production chunk can load before support.ts stops the unsupported app.
const listening = typeof window !== 'undefined' && !window.nseUnsupported

if (listening) {
    for (const type of [...POINTER_EVENTS, ...KEY_EVENTS])
        window.addEventListener(type, swallow, { capture: true })
}

/** The gate's element, so presses on its own buttons get through. */
export const registerGateElement = (target: HTMLElement | undefined) => {
    element = target
}

const startSlowTimer = (ms: number) => {
    clearTimeout(slowTimer)
    slowTimer = setTimeout(() => {
        if (startupGate.phase === 'opening') startupGate.slow = true
    }, ms)
}

const slowDelay = () => readFlags().slowMs ?? SLOW_MS

if (listening) startSlowTimer(slowDelay())

/**
 * Resolves once startup has ended, whether it opened the session or stopped at an error. Work
 * that waits for the page to settle starts from it.
 */
export const startupEnded = () =>
    new Promise<void>((resolve) => {
        if (startupGate.phase !== 'opening') {
            resolve()
            return
        }
        const stop = watch(
            () => startupGate.phase,
            (phase) => {
                if (phase === 'opening') return
                stop()
                resolve()
            },
        )
    })

/** The session being opened has a name: "Opening "Coconut (Master)"…". */
export const setOpeningName = (name: string | undefined) => {
    startupGate.name = name
}

/** The session is open: input reaches the editor. */
export const finishStartup = () => {
    if (startupGate.phase === 'done') return
    clearTimeout(slowTimer)
    markStartup(startupGate.slow ? 'slow' : 'done')
    startupGate.asking = undefined
    startupGate.phase = 'done'
    if (listening)
        for (const type of [...POINTER_EVENTS, ...KEY_EVENTS])
            window.removeEventListener(type, swallow, { capture: true })
}

/** Startup threw: the gate says so, with the error's own text, and stays. */
export const failStartup = (error: unknown) => {
    console.error(error)
    // Once the editor is open, a late failure doesn't take it away again.
    if (startupGate.phase === 'done') return
    clearTimeout(slowTimer)
    markStartup('error')
    startupGate.asking = undefined
    startupGate.error = errorMessage(error)
    startupGate.phase = 'error'
}

/**
 * Follows the startup sequence (the database opening, the recovery order and loading the
 * session): the gate lifts when it resolves and shows its error when it rejects.
 */
export const trackStartup = (task: Promise<unknown>) => {
    const flags = readFlags()
    void (async () => {
        await task
        if (flags.hold)
            await new Promise<void>((resolve) => {
                window.nseStartupRelease = resolve
            })
        if (flags.fail !== undefined) throw new Error(flags.fail)
    })().then(finishStartup, failStartup)
}

let startBlankHandler: (() => void | Promise<void>) | undefined

/**
 * What Start Blank does besides lifting the gate: the startup sequence stops waiting for the
 * stored session, leaving it untouched, and the editor opens blank. Without one, the gate lifts
 * and startup carries on in the background.
 */
export const setStartBlankHandler = (handler: (() => void | Promise<void>) | undefined) => {
    startBlankHandler = handler
}

export const startBlank = async () => {
    try {
        await startBlankHandler?.()
    } catch (error) {
        console.error(error)
    }
    finishStartup()
}

export type UnfinishedAnswer = 'blank' | 'again'

let answerAsk: ((answer: UnfinishedAnswer) => void) | undefined

/**
 * Asks, before a stored session is read, what to do about one that did not finish opening last
 * time. The slow timer waits while it asks. Resolves to `blank` when the gate is not asking
 * (it ended already), the safe side.
 */
export const askUnfinished = (name: string | undefined): Promise<UnfinishedAnswer> => {
    if (startupGate.phase !== 'opening') return Promise.resolve('blank')
    clearTimeout(slowTimer)
    startupGate.asking = { name }
    return new Promise<UnfinishedAnswer>((resolve) => {
        answerAsk = resolve
    })
}

/** The question's buttons: Start Blank lifts the gate as the slow state's does. */
export const answerUnfinished = async (answer: UnfinishedAnswer) => {
    const resolve = answerAsk
    if (!resolve) return
    answerAsk = undefined
    if (answer === 'blank') await startBlank()
    else if (!startupGate.slow) startSlowTimer(slowDelay())
    startupGate.asking = undefined
    resolve(answer)
}

/** Export Raw Data registers here once built, and the error state offers it. */
export const setRawExport = (rawExport: RawExport | undefined) => {
    startupGate.rawExport = rawExport
}

/** The error state's button: runs the export and shows its line, a failure included. */
export const runRawExport = async () => {
    const { rawExport } = startupGate
    if (!rawExport || startupGate.rawExportRunning) return
    startupGate.rawExportRunning = true
    startupGate.rawExportNote = undefined
    try {
        startupGate.rawExportNote = await rawExport.run()
    } catch (error) {
        // The export says its own failures; this is a bug in it.
        console.error(error)
    } finally {
        startupGate.rawExportRunning = false
    }
}
