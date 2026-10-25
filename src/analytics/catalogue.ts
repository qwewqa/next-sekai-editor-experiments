import { operationCodecs, type OperationId } from '../history/operations/registry'
import type { LoadEvent } from '../local/startup/events'

// Every event the usage statistics may send, and every value each property may take. The client
// checks each event against this before it queues it and drops one that fails, so a value that
// slips past the types (through `as`) never leaves. docs/analytics.md lists the same events; a unit
// test keeps the two in step.

/** The ranges numbers are sent as. Each list is in order, and each range's label is its value. */
export const scales = {
    /** Milliseconds. */
    time: [
        '<50',
        '50-100',
        '100-200',
        '200-500',
        '500-1k',
        '1k-2k',
        '2k-5k',
        '5k-10k',
        '10k-30k',
        '30k+',
    ],
    /** Bytes; K is KiB and M is MiB. */
    size: ['<16K', '16K-64K', '64K-256K', '256K-1M', '1M-4M', '4M-16M', '16M-64M', '64M+'],
    objects: [
        '0',
        '1-9',
        '10-99',
        '100-499',
        '500-999',
        '1k-2k',
        '2k-5k',
        '5k-10k',
        '10k-20k',
        '20k+',
    ],
    small: ['0', '1', '2-5', '6-20', '21-100', '101+'],
    /** An audio file's length. */
    audio: ['<1m', '1m-2m', '2m-3m', '3m-5m', '5m-10m', '10m+'],
    /** Time spent in a visit, such as playing. */
    duration: ['0', '<1m', '1m-5m', '5m-20m', '20m-60m', '60m+'],
    /** A long animation frame's length, in milliseconds. */
    frame: ['50-100', '100-200', '200-500', '500+'],
    quota: ['<1G', '1G-10G', '10G-100G', '100G+'],
    cores: ['1-2', '3-4', '5-8', '9+'],
    /** The window's width in CSS pixels. */
    viewport: ['s', 'm', 'l', 'xl'],
    dpr: ['1', '<2', '<3', '3+'],
    /** The preview's note speed; 10 is the default. */
    noteSpeed: ['<8', '8-10', '10', '10-12'],
} as const

export type Scale = keyof typeof scales

declare const scaleBrand: unique symbol
/** A range label, made only by `bucket`, so a raw number or string cannot be sent as one. */
export type Bucket<S extends Scale> = (typeof scales)[S][number] & { readonly [scaleBrand]: S }

const K = 1024
const M = K * K
const G = K * M
const MINUTE = 60_000

/** Each scale's upper limits, exclusive; a value at or past the last takes the last range. */
const limits: Record<Scale, readonly number[]> = {
    time: [50, 100, 200, 500, 1000, 2000, 5000, 10_000, 30_000],
    size: [16 * K, 64 * K, 256 * K, M, 4 * M, 16 * M, 64 * M],
    objects: [1, 10, 100, 500, 1000, 2000, 5000, 10_000, 20_000],
    small: [1, 2, 6, 21, 101],
    audio: [1, 2, 3, 5, 10].map((minutes) => minutes * MINUTE),
    duration: [Number.MIN_VALUE, MINUTE, 5 * MINUTE, 20 * MINUTE, 60 * MINUTE],
    frame: [100, 200, 500],
    quota: [G, 10 * G, 100 * G],
    cores: [3, 5, 9],
    viewport: [640, 1024, 1440],
    dpr: [1.01, 2, 3],
    noteSpeed: [8, 10, 10.000_001],
}

/** The range a number falls in. */
export const bucket = <S extends Scale>(scale: S, value: number): Bucket<S> => {
    const at = limits[scale].findIndex((limit) => value < limit)
    const labels = scales[scale]
    return labels[at < 0 ? labels.length - 1 : at] as Bucket<S>
}

/** A use count: whole, and capped at 9999 a visit. */
export const COUNT_CAP = 9999

type Prop =
    | 'boolean'
    | 'count'
    | { readonly scale: Scale }
    | { readonly oneOf: readonly string[] }
    | { readonly pattern: RegExp }

const oneOf = <const T extends readonly string[]>(...values: T) => ({ oneOf: values })
const scale = <const S extends Scale>(name: S) => ({ scale: name })
const counts = <const T extends string>(keys: readonly T[]) =>
    Object.fromEntries(keys.map((key) => [key, 'count'])) as Record<T, 'count'>
const flags = <const T extends string>(keys: readonly T[]) =>
    Object.fromEntries(keys.map((key) => [key, 'boolean'])) as Record<T, 'boolean'>
const prefixed = <const P extends string, const T extends string>(prefix: P, keys: readonly T[]) =>
    keys.map((key) => `${prefix}.${key}` as const)

const position = oneOf('auto', 'left', 'right', 'top', 'disabled')
const assetSource = oneOf('default', 'builtin', 'file')
const fileError = [
    'conflict',
    'not-found',
    'denied',
    'not-local',
    'no-space',
    'read-only',
    'io',
] as const

/** The load events a startup may find, as `found.<kind>`. */
const loadKinds = [
    'continued',
    'storageCleared',
    'journalKept',
    'unsavedRecovered',
    'unsavedInLocalData',
    'migrationFailed',
    'migrated',
    'migratedRevision',
    'journalRecovered',
    'journalLater',
    'storageNearlyFull',
    'journalFailed',
    'journalsFull',
    'notOpened',
    'openElsewhere',
    'deletedElsewhere',
    'separateCopy',
    'bgmNotLoaded',
] as const satisfies readonly LoadEvent['kind'][]
// Every kind is listed: a new kind fails the type check until it is added.
const _everyKind: LoadEvent['kind'] extends (typeof loadKinds)[number] ? true : never = true

/** History's operations as `edits` counts them: without the `nse.` prefix. */
type EditKey = OperationId extends `nse.${infer Rest}` ? Rest : never
const editKeys = Object.keys(operationCodecs).map((id) => id.replace(/^nse\./, '') as EditKey)

/** Where a command was run from; `nested` and `repeat` are never counted. */
export const sources = ['key', 'toolbar', 'menu', 'gesture', 'wheel', 'panel', 'button'] as const
export type Source = (typeof sources)[number] | 'nested' | 'repeat'

export const catalogue = {
    visit: {
        version: { pattern: /^\d+\.\d+\.\d+$/ },
        site: oneOf('production', 'test'),
        os: oneOf('windows', 'macos', 'linux', 'ios', 'android', 'other'),
        engine: oneOf('chromium', 'webkit', 'firefox', 'other'),
        standalone: 'boolean',
        touch: 'boolean',
        viewport: scale('viewport'),
        dpr: scale('dpr'),
        browserLanguage: { pattern: /^(?:[a-z]{2,3}|other)$/ },
        returning: 'boolean',
        updated: 'boolean',
    },
    settings: {
        theme: oneOf('system', 'light', 'dark'),
        themeShown: oneOf('light', 'dark'),
        locale: oneOf('en', 'fr', 'ja', 'ko', 'tr', 'zhs', 'zht'),
        previewInWorker: 'boolean',
        previewRenderScale: oneOf('0.25', '0.5', '0.75', '1', '1.25', '1.5', '1.75', '2'),
        previewAntialias: 'boolean',
        previewShowHitboxes: 'boolean',
        previewNoteSpeed: scale('noteSpeed'),
        'previewAssets.skin': assetSource,
        'previewAssets.particle': assetSource,
        'previewAssets.background': assetSource,
        'previewAssets.effect': assetSource,
        showPreview: 'boolean',
        previewPosition: position,
        showMinimap: oneOf('auto', 'on', 'off'),
        showHistory: 'boolean',
        historyPosition: position,
        dimUnchangedObjects: 'boolean',
        waveform: oneOf('volume', 'fft', 'off'),
        beatDisplay: oneOf('beat', 'measure', 'both'),
        toolbarQuickSwitch: 'boolean',
        toolbarCustomized: 'boolean',
        mouseSecondaryTool: oneOf('eraser', 'select', 'selectContextMenu'),
        playFollow: 'boolean',
        touchQuickScrollShow: oneOf('on', 'off', 'touch'),
        touchLongPressContextMenu: 'boolean',
        confirmCloseUnsavedFile: 'boolean',
    },
    startup: {
        start: oneOf('continued', 'reload', 'recovered', 'launchFile', 'blank', 'safeMode'),
        outcome: oneOf('done', 'error', 'slow'),
        ready: scale('time'),
        ...flags(prefixed('found', loadKinds)),
    },
    storage: {
        mode: oneOf('stored', 'readOnly', 'memory', 'memory-private'),
        reason: oneOf('full', 'upgrading', 'olderTabs', 'failed'),
        persisted: oneOf('granted', 'not', 'unsupported'),
        usage: scale('size'),
        quota: scale('quota'),
        cleanup: 'boolean',
        sessions: scale('small'),
    },
    chart: {
        trigger: oneOf('open', 'restore', 'save'),
        notes: scale('objects'),
        slides: scale('objects'),
        bpms: scale('objects'),
        timeScales: scale('objects'),
        events: scale('objects'),
        stages: scale('small'),
        groups: scale('small'),
        dynamicStages: 'boolean',
        bgm: oneOf('none', ...scales.audio),
        historySteps: scale('objects'),
    },
    preview: {
        host: oneOf('main', 'worker'),
        reason: oneOf('webgl2', 'error', 'timeout', 'transfer'),
        workerFrames: oneOf('none', 'some'),
        graphics: oneOf('ok', 'unavailable'),
    },
    open: {
        format: oneOf('nxsp', 'levelData', 'sus', 'usc', 'chcy', 'other'),
        via: oneOf('picker', 'drop', 'launch'),
        size: scale('size'),
        outcome: oneOf('done', 'cancelled', 'refused', 'failed'),
        reason: oneOf(...fileError),
        took: scale('time'),
    },
    save: {
        action: oneOf('save', 'saveAs', 'saveToFile', 'downloadAgain'),
        target: oneOf('writeBack', 'picker', 'download'),
        history: 'boolean',
        bgm: 'boolean',
        size: scale('size'),
        took: scale('time'),
        outcome: oneOf(
            'done',
            'cancelled',
            'noChanges',
            'forked',
            'unlinked',
            'refused',
            'conflict',
            'failed',
            'error',
        ),
        reason: oneOf(...fileError, 'notKept', 'notProject', 'levelData', 'safeMode'),
        step: oneOf('build', 'read', 'readBack', 'download', 'check'),
    },
    export: {
        format: oneOf('levelData', 'other'),
        target: oneOf('picker', 'download'),
        size: scale('size'),
        took: scale('time'),
        outcome: oneOf('done', 'cancelled', 'failed'),
        reason: oneOf(...fileError),
    },
    check: {
        outcome: oneOf('ok', 'problems', 'failed'),
        took: scale('time'),
    },
    bgm: {
        format: oneOf('mp3', 'ogg', 'wav', 'flac', 'm4a', 'other'),
        size: scale('size'),
        length: scale('audio'),
        took: scale('time'),
        outcome: oneOf('done', 'cancelled', 'failed'),
    },
    edits: counts([...editKeys, 'undo', 'redo']),
    features: counts([
        'historyPanel',
        'historyDialog',
        'recentTab',
        'peek',
        'peekRefused',
        'restore',
        'restoreSession',
        'restoreCopy',
        'saveRowToFile',
        'deleteSessions',
        'minimapDrag',
        'minimapJump',
        'quickSwitch',
    ]),
    notices: counts(['info', 'warning', 'error']),
    perf: {
        ...counts(prefixed('peek', [...scales.time, 'cached'])),
        loafSupported: 'boolean',
        ...counts(prefixed('frames.playing', scales.frame)),
        ...counts(prefixed('frames.busy', scales.frame)),
        ...counts(prefixed('frames.other', scales.frame)),
        playSeconds: scale('duration'),
        slowInputs: 'count',
        interactions: 'count',
        visibleTime: scale('duration'),
        cores: scale('cores'),
    },
    errors: counts(['error', 'csp']),
} as const satisfies Record<string, Record<string, Prop>>

/** The events with fixed properties; `usage`'s keys are made from the command names. */
export type EventName = keyof typeof catalogue | 'usage'

type ValueOf<P> = P extends 'boolean'
    ? boolean
    : P extends 'count'
      ? number
      : P extends { scale: infer S extends Scale }
        ? Bucket<S>
        : P extends { oneOf: readonly (infer V)[] }
          ? V
          : P extends { pattern: RegExp }
            ? string
            : never

/** An event's data: any of its properties, each of its own type. */
export type EventData<E extends keyof typeof catalogue> = {
    -readonly [K in keyof (typeof catalogue)[E]]?: ValueOf<(typeof catalogue)[E][K]>
}

/** The most properties one event carries; a summary with more is split. */
export const MAX_KEYS = 45

const fits = (prop: Prop, value: unknown) => {
    if (prop === 'boolean') return typeof value === 'boolean'
    if (prop === 'count')
        return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= COUNT_CAP
    if (typeof value !== 'string') return false
    if ('scale' in prop) return (scales[prop.scale] as readonly string[]).includes(value)
    if ('oneOf' in prop) return prop.oneOf.includes(value)
    return prop.pattern.test(value)
}

const usageKey = /^([a-zA-Z][a-zA-Z0-9]*)\.([a-z]+)$/

/**
 * Whether an event may be sent: a known name, at most MAX_KEYS properties, each known and in its
 * set. `usage` takes `<command>.<source>` counts, for the built-in command names given.
 */
export const isValidEvent = (
    name: string,
    data: Record<string, unknown>,
    commandNames: ReadonlySet<string> = new Set(),
) => {
    const entries = Object.entries(data)
    if (entries.length > MAX_KEYS) return false
    if (name === 'usage')
        return entries.every(([key, value]) => {
            const [, command = '', source = ''] = usageKey.exec(key) ?? []
            return (
                commandNames.has(command) &&
                (sources as readonly string[]).includes(source) &&
                fits('count', value)
            )
        })
    if (!Object.hasOwn(catalogue, name)) return false
    const props = catalogue[name as keyof typeof catalogue] as Record<string, Prop>
    return entries.every(([key, value]) => {
        const prop = Object.hasOwn(props, key) ? props[key] : undefined
        return prop !== undefined && fits(prop, value)
    })
}
