import { i18n } from '../i18n'
import { formatDate } from '../i18n/when'
import { loadEvents, onLoadEvent, type LoadEvent, type ShownName } from '../local/startup/events'
import { interpolate, interpolateRaw } from '../utils/interpolate'
import { changeBgm } from './commands/bgm'
import { openHistoryAction } from './history/openHistory'
import { LOAD_ORDER } from './loadOrder'
import { addLoadNotice, setLocalDataOpener, type NoticeAction } from './notification'
import { openSettings } from './settings/openSettings'
import { shownName } from './shownName'
import { restoreCopy } from './switch'

// What this load found (the events of `local/startup/events.ts`) as the start-up pill's load
// notices, with their actions (Part 1 §1.4.3). Restore Session (Step 7) is left out until that step
// adds it.

const quoted = (name: ShownName) => () => shownName(name)

const openLocalData = () => {
    void openSettings('localData')
}
setLocalDataOpener(openLocalData)

const localData: NoticeAction = { label: () => i18n.value.load.localData, run: openLocalData }

const restoreAsCopy = (sessionId: string): NoticeAction => ({
    label: () => i18n.value.load.restoreAsCopy,
    run: () => {
        void restoreCopy(sessionId)
    },
})

const chooseAudio: NoticeAction = {
    label: () => i18n.value.notice.chooseAudio,
    run: () => {
        void changeBgm()
    },
}

type Line = { order: number; message: () => string; action?: NoticeAction }

const load = () => i18n.value.load

type Handlers = { [K in LoadEvent['kind']]: (event: Extract<LoadEvent, { kind: K }>) => Line }

/**
 * The load notice of each kind of event. Keyed by kind and checked by the compiler, so an event
 * added to `local/startup/events.ts` has no way to stay silent.
 */
export const loadNoticeOf: Handlers = {
    continued: ({ name, from }) => ({
        order: LOAD_ORDER.continued,
        message:
            name.name.kind === 'date'
                ? () => interpolateRaw(load().continuedUntitled, formatDate(from))
                : () => interpolateRaw(load().continued, shownName(name), formatDate(from)),
        action: { ...openHistoryAction(), label: () => load().openHistory },
    }),
    storageCleared: () => ({ order: LOAD_ORDER.storageCleared, message: () => load().cleared }),
    journalKept: (event) => ({
        order: LOAD_ORDER.journalKept,
        message: interpolate(() => load().journalKept, quoted(event.name)),
    }),
    unsavedRecovered: () => ({
        order: LOAD_ORDER.unsavedRecovered,
        message: () => load().fallback,
    }),
    unsavedInLocalData: () => ({
        order: LOAD_ORDER.unsavedInLocalData,
        message: () => load().fallbackLocal,
        action: localData,
    }),
    migrationFailed: () => ({
        order: LOAD_ORDER.migrationFailed,
        message: () => load().migrationFailed,
        action: localData,
    }),
    migrated: (event) => ({
        order: LOAD_ORDER.migrated,
        // Kept as a session of its own when another session opened (§1.4.3).
        message: interpolate(
            () => (event.opened ? load().autoSave : load().autoSaveKept),
            quoted(event.name),
        ),
    }),
    migratedRevision: () => ({
        order: LOAD_ORDER.migratedRevision,
        // Today's warning on an older engine revision (D18).
        message: () => i18n.value.commands.open.revision.older,
    }),
    journalRecovered: (event) => ({
        order: LOAD_ORDER.journalRecovered,
        message: interpolate(() => load().journal, quoted(event.name)),
    }),
    journalLater: () => ({ order: LOAD_ORDER.journalLater, message: () => load().journalLater }),
    journalFailed: () => ({
        order: LOAD_ORDER.journalFailed,
        message: () => load().journalFailed,
        action: localData,
    }),
    journalsFull: () => ({
        order: LOAD_ORDER.journalsFull,
        message: () => load().journalsFull,
        action: localData,
    }),
    notOpened: ({ which, why }) => ({
        order: LOAD_ORDER.notOpened,
        message: () =>
            which === 'reload'
                ? why === 'later'
                    ? load().sessionLater
                    : load().sessionDamaged
                : why === 'later'
                  ? load().newestLater
                  : load().newestDamaged,
    }),
    openElsewhere: (event) => ({
        order: LOAD_ORDER.openElsewhere,
        message: interpolate(() => load().openElsewhere, quoted(event.name)),
        action: restoreAsCopy(event.sessionId),
    }),
    deletedElsewhere: () => ({
        order: LOAD_ORDER.deletedElsewhere,
        message: () => load().sessionDeleted,
    }),
    separateCopy: (event) => ({
        order: LOAD_ORDER.separateCopy,
        message: interpolate(() => i18n.value.notice.sameFileElsewhere, event.of.name),
    }),
    bgmNotLoaded: () => ({
        order: LOAD_ORDER.bgmNotLoaded,
        message: () => load().bgmNotLoaded,
        action: chooseAudio,
    }),
}

/** The load notice for an event. */
export const lineOf = (event: LoadEvent): Line =>
    (loadNoticeOf[event.kind] as (event: LoadEvent) => Line)(event)

const add = (event: LoadEvent) => {
    const { message, action, order } = lineOf(event)
    addLoadNotice(message, action, order)
}

// Events found before this module loaded come first.
for (const event of loadEvents.value) add(event)
onLoadEvent(add)
