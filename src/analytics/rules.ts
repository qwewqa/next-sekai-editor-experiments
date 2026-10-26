import type { HistoryAction } from '../history/actions'
import { languageTag } from '../i18n/plural'
import type { EventData } from './catalogue'
import type { Item } from './sender'

// What the client decides from what it reads, apart from the reading: how a visit began, and which
// History actions are counted as `edits`. Kept free of the editor's modules so a test can run them.

const operationId = (operation: unknown) =>
    typeof operation === 'object' &&
    operation !== null &&
    'id' in operation &&
    typeof operation.id === 'string'
        ? operation.id.replace(/^nse\./, '')
        : undefined

/** The `edits` counter an action adds to, without its prefix; undefined for an action not counted. */
export const editKey = (action: HistoryAction) => {
    if (action.kind === 'undo' || action.kind === 'redo') return action.kind
    if (action.kind === 'edit' || action.kind === 'restore')
        return operationId(action.step.operation)
    return undefined
}

const recoveredKinds = ['journalRecovered', 'unsavedRecovered', 'journalKept']

/** How the visit began, from the load events and the tab’s claim; the first that fits. */
export const startKind = (
    safeMode: boolean,
    loadKinds: ReadonlySet<string>,
    reloaded: boolean,
): NonNullable<EventData<'startup'>['start']> => {
    if (safeMode) return 'safeMode'
    if (recoveredKinds.some((kind) => loadKinds.has(kind))) return 'recovered'
    if (loadKinds.has('continued')) return 'continued'
    return reloaded ? 'reload' : 'blank'
}

/** What every item of a request carries, whatever its event. */
export const requestFields = (page: {
    website: string
    hostname: string
    screenWidth: number
    screenHeight: number
    locale: string
    referrer: string
}) => ({
    website: page.website,
    hostname: page.hostname,
    screen: `${page.screenWidth}x${page.screenHeight}`,
    language: languageTag(page.locale),
    url: '/',
    title: '',
    referrer: page.referrer,
})

/** One item of a request: the page view when it has no name, else an event. `at` is in milliseconds. */
export const requestItem = (
    fields: ReturnType<typeof requestFields>,
    name?: string,
    data?: Record<string, unknown>,
    at = Date.now(),
): Item => ({
    type: 'event',
    payload: { ...fields, ...(name && { name, data }), timestamp: Math.floor(at / 1000) },
})
