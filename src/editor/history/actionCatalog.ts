import en from '../../i18n/en/index.json'
import fr from '../../i18n/fr/index.json'
import ja from '../../i18n/ja/index.json'
import ko from '../../i18n/ko/index.json'
import tr from '../../i18n/tr/index.json'
import zhs from '../../i18n/zhs/index.json'
import zht from '../../i18n/zht/index.json'
import { pluralForm } from '../../i18n/plural'
import type { EntityType } from '../../state/entities'
import { fieldLabel, propertyFields } from '../workspace/properties/fields'

export type Messages = typeof en
export type SummaryKey = keyof Messages['history']['summary']
export type EventKind = keyof Messages['eventKinds']
export type Action = Readonly<{
    family: string
    summary?: SummaryKey
    count?: number
    field?: string
    event?: EventKind
    creation?: 'add' | 'generate'
    fixed?: 'bgmFile' | 'bgm' | 'dynamicStages'
}>

const dictionaries: Readonly<Record<string, Messages>> = { en, fr, ja, ko, tr, zhs, zht }
export const catalogLocales = Object.freeze(Object.keys(dictionaries))
export const catalogMessages = (locale: string) => dictionaries[locale] ?? en

/** Explicit-locale, one-pass interpolation; classification never changes application locale. */
export const fillMessage = (locale: string, template: string, ...params: string[]) =>
    pluralForm(locale, template, params[0]).replace(
        /\{(\d+)\}/g,
        (placeholder, index: string) => params[Number(index)] ?? placeholder,
    )

const at = (messages: Messages, path: string): string => {
    let value: unknown = messages
    for (const key of path.split('.')) value = (value as Record<string, unknown>)[key]
    if (typeof value !== 'string') throw new Error(`Missing action template: ${path}`)
    return value
}

type Definition = { key: string; action: Omit<Action, 'count'>; domain?: 'one' | 'positive' }
const counted: Definition[] = []
const add = (key: string, family: string, summary: SummaryKey, extra: Partial<Action> = {}) =>
    counted.push({ key, action: { family, summary, ...extra } })
for (const tool of ['note', 'slide']) {
    add(`tools.${tool}.added`, 'note.add', 'addedNotes', { creation: 'add' })
    counted[counted.length - 1]!.domain = 'one'
    add(`tools.${tool}.edited`, 'note.edit', 'editedNotes')
    add(`tools.${tool}.moved`, 'note.move', 'movedNotes')
}
for (const [tool, subject] of [['bpm', 'Bpm'], ['timeScale', 'TimeScales']] as const)
    for (const [verb, action] of [['added', 'add'], ['edited', 'edit'], ['moved', 'move'], ['replaced', 'replace']] as const)
        add(`tools.${tool}.${verb}`, `${tool}.${action}`, `${verb}${subject}`)
for (const [key, family, summary] of [
    ['tools.select.moved', 'object.move', 'movedObjects'],
    ['tools.paste.pasted', 'object.paste', 'pastedObjects'],
    ['tools.brush.brushed', 'object.brush', 'brushedObjects'],
    ['tools.eraser.erased', 'object.delete', 'deletedObjects'],
    ['contextMenu.deleted', 'object.delete', 'deletedObjects'],
    ['commands.cut.cut', 'object.cut', 'cutObjects'],
    ['commands.flip.flipped', 'object.flip', 'flippedHorizontally'],
    ['commands.flipVertical.flipped', 'object.flipVertical', 'flippedVertically'],
    ['commands.scaleBeat.scaled', 'object.scaleBeat', 'scaledBeats'],
    ['commands.scaleWidth.scaled', 'object.scaleWidth', 'scaledWidth'],
    ['commands.scaleElevation.scaled', 'object.scaleElevation', 'scaledElevations'],
    ['commands.combineNotes.combined', 'note.combine', 'combinedNotes'],
    ['commands.splitHold.split', 'note.split', 'splitSlideConnections'],
    ['commands.makeVertical.made', 'note.vertical', 'madeNotesVertical'],
    ['elevation.changed', 'note.elevation', 'changedNoteElevations'],
    ['sidebars.default.edited', 'object.edit', 'editedObjects'],
    ['sidebars.default.editedNotes', 'note.edit', 'editedNotes'],
] as const) add(key, family, summary)
add('tools.generateSlideNotes.generated', 'note.generate', 'generatedNotes', { creation: 'generate' })
counted[counted.length - 1]!.domain = 'positive'

const excluded = [
    'commands.properties.lifeSet', 'commands.bgm.offsetSet',
    'entry.recovered', 'entry.changedOutside', 'history.restoredTo',
    ...['manageGroups', 'manageStages'].flatMap((manager) =>
        ['added', 'moved', 'deleted'].map((verb) => `commands.${manager}.modal.${verb}`)),
    ...['groups', 'stages'].flatMap((owner) => [
        'renamed', 'propertySet', ...(owner === 'groups' ? ['propertyCleared'] : []),
        'movedSelectedInto', 'movedSelectedOut', 'deletedSelected', 'deletedSelectedFolders',
        'duplicated', 'duplicatedSelected', 'duplicatedSelectedFolders',
    ].map((verb) => `workspace.${owner}.${verb}`)),
    ...['added', 'renamed', 'moved', 'movedInto', 'movedOut', 'duplicated', 'ungrouped', 'deleted']
        .map((verb) => `workspace.folders.${verb}`),
]
const eventTypes = {
    cameraEvent: 'cameraEventJoint', stageMaskEvent: 'stageMaskEventJoint',
    stagePivotEvent: 'stagePivotEventJoint', stageStyleEvent: 'stageStyleEventJoint',
    stageTransformEvent: 'stageTransformEventJoint',
} as const
const subjects: { type: EntityType; template: string; family: string; summary: SummaryKey; event?: EventKind }[] = [
    { type: 'note', template: 'setNotes', family: 'note', summary: 'setOnNotes' },
    { type: 'bpm', template: 'setBpm', family: 'bpm', summary: 'setOnBpm' },
    { type: 'timeScale', template: 'setTimeScales', family: 'timeScale', summary: 'setOnTimeScales' },
    ...Object.entries(eventTypes).map(([event, type]) => ({ type, template: 'setEvents', family: 'event', summary: 'setOnEvents' as const, event: event as EventKind })),
]

type Candidate = { locale: string; message: string; params: string[]; pattern: RegExp; action: Omit<Action, 'count'>; domain?: Definition['domain'] }
type Veto = readonly string[]
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
let compiled: { buckets: Map<string, Candidate[]>; numeric: Candidate[]; vetoes: Veto[] } | undefined
const cache = new Map<string, Action | undefined>()

const compile = () => {
    if (compiled) return compiled
    const buckets = new Map<string, Candidate[]>()
    const numeric: Candidate[] = []
    const vetoes: Veto[] = []
    const candidate = (locale: string, key: string, action: Omit<Action, 'count'>, params: string[] = [], domain?: Definition['domain']) => {
        const message = at(catalogMessages(locale), key)
        for (const form of message.split('|')) {
            const expanded = form.replace(/\{([1-9]\d*)\}/g, (placeholder, i: string) => params[Number(i)] ?? placeholder)
            const pieces = expanded.split('{0}')
            if (pieces.length !== 2) throw new Error(`Invalid counted template: ${key}`)
            const prefix = pieces[0] ?? ''
            const item: Candidate = { locale, message, params, action, domain, pattern: new RegExp(`^${escape(prefix)}([0-9]{1,16})${escape(pieces[1] ?? '')}$`) }
            const list = prefix ? (buckets.get(prefix[0]!) ?? []) : numeric
            list.push(item)
            if (prefix) buckets.set(prefix[0]!, list)
        }
    }
    for (const locale of catalogLocales) {
        const messages = catalogMessages(locale)
        for (const { key, action, domain } of counted) candidate(locale, key, action, [], domain)
        for (const event of Object.keys(eventTypes) as EventKind[])
            for (const [verb, family] of [['added', 'add'], ['edited', 'edit'], ['moved', 'move']] as const)
                candidate(locale, `tools.events.${verb}`, { family: `event.${family}`, summary: `${verb}Events`, event }, ['', messages.eventKinds[event]])
        for (const field of propertyFields) {
            const applicable = subjects.filter(({ type }) => field.show({ types: { [type]: true }, noteFields: {}, count: 1, isDynamicStages: true }))
            const name = fieldLabel(field, messages, true)
            for (const subject of applicable)
                candidate(locale, `sidebars.default.${subject.template}`, { family: `property.${subject.family}`, summary: subject.summary, field: field.key, event: subject.event }, ['', name, subject.event ? messages.eventKinds[subject.event] : ''])
            if (applicable.length > 1)
                candidate(locale, 'sidebars.default.set', { family: 'property.object', summary: 'setOnObjects', field: field.key }, ['', name])
        }
        for (const key of excluded)
            for (const form of at(messages, key).split('|')) vetoes.push(Object.freeze(form.split(/\{\d+\}/g)))
    }
    compiled = { buckets, numeric, vetoes }
    return compiled
}

/** Name/value templates veto only; no arbitrary text becomes a semantic identity. */
const compatible = (parts: Veto, label: string) => {
    const first = parts[0] ?? ''
    if (!label.startsWith(first)) return false
    if (parts.length === 1) return label === first
    let end = first.length
    for (const part of parts.slice(1, -1)) {
        const at = label.indexOf(part, end)
        if (at < 0) return false
        end = at + part.length
    }
    const last = parts.at(-1) ?? ''
    return label.endsWith(last) && label.length - last.length >= end
}

export const actionIdentity = (action: Action) =>
    JSON.stringify([action.family, action.field, action.event, action.fixed])

export const classifyAction = (label: string): Action | undefined => {
    if (label.length > 1024) return
    if (cache.has(label)) return cache.get(label)
    const catalog = compile()
    let result: Action | undefined
    let conflict = false
    for (const candidate of [...(catalog.buckets.get(label[0] ?? '') ?? []), ...catalog.numeric]) {
        const found = candidate.pattern.exec(label)
        if (!found) continue
        const raw = found[1] ?? ''
        const count = Number(raw)
        if (!Number.isSafeInteger(count) || String(count) !== raw || count < 0 ||
            (candidate.domain === 'one' && count !== 1) || (candidate.domain === 'positive' && !count)) continue
        if (fillMessage(candidate.locale, candidate.message, raw, ...candidate.params.slice(1)) !== label) continue
        const action = Object.freeze({ ...candidate.action, count })
        if (result && (actionIdentity(result) !== actionIdentity(action) || result.count !== count)) conflict = true
        result = action
    }
    for (const locale of catalogLocales) {
        const messages = catalogMessages(locale)
        for (const [message, fixed] of [[messages.commands.bgm.fileChanged, 'bgmFile'], [messages.commands.bgm.changed, 'bgm'], [messages.history.dynamicStages.enabled, 'dynamicStages']] as const)
            if (label === message) {
                const action = Object.freeze({ family: `fixed.${fixed}`, fixed })
                if (result && actionIdentity(result) !== actionIdentity(action)) conflict = true
                result = action
            }
    }
    if (conflict || (result && catalog.vetoes.some((parts) => compatible(parts, label)))) result = undefined
    if (cache.size >= 2048) cache.delete(cache.keys().next().value ?? '')
    cache.set(label, result)
    return result
}
