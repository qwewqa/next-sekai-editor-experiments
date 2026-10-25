import { operationCodecs, type OperationId } from '../history/operations/registry'
import type { LoadEvent } from '../local/startup/events'
import { bucket, scales, type Bucket, type Scale } from './scales'

// Every event the usage statistics may send, and every value each property may take. The client
// checks each event against this before it queues it and drops one that fails, so a value that
// slips past the types (through `as`) never leaves. docs/analytics.md lists the same events; a unit
// test keeps the two in step.

export { bucket, scales, type Bucket, type Scale } from './scales'

/** A use count: whole, and capped at 9999 a visit. */
export const COUNT_CAP = 9999

/** A measured count as a use count: whole, not below 0, and capped. */
export const capCount = (value: number) => Math.min(COUNT_CAP, Math.max(0, Math.round(value)))

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
        reason: oneOf(...fileError, 'unsupported', 'invalid'),
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
    // Sent by the support page (public/gate.js), not by the client.
    unsupported: { engine: oneOf('chromium', 'webkit', 'firefox', 'other') },
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

/**
 * What a flow hands to `record`: the event's data with each range as the plain number it
 * measures (milliseconds, bytes), which `fromRaw` turns into the range when the client sends it.
 */
export type RawData<E extends keyof typeof catalogue> = {
    -readonly [K in keyof (typeof catalogue)[E]]?: (typeof catalogue)[E][K] extends {
        scale: Scale
    }
        ? number
        : ValueOf<(typeof catalogue)[E][K]>
}

/** A recorded event's data with its numbers made ranges. */
export const fromRaw = (name: string, raw: Record<string, unknown>) => {
    const props = (
        Object.hasOwn(catalogue, name) ? catalogue[name as keyof typeof catalogue] : {}
    ) as Record<string, Prop>
    return Object.fromEntries(
        Object.entries(raw).map(([key, value]) => {
            const prop = props[key]
            return [
                key,
                prop && typeof prop === 'object' && 'scale' in prop && typeof value === 'number'
                    ? bucket(prop.scale, value)
                    : value,
            ]
        }),
    )
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
