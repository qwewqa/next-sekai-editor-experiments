import { i18n } from '../i18n'
import { formatDateInSentence } from '../i18n/when'
import { loadEvents, onLoadEvent, type LoadEvent, type ShownName } from '../local/startup/events'
import { platform } from '../platform'
import { interpolate, interpolateRaw } from '../utils/interpolate'
import { changeBgm } from './commands/bgm'
import { copyPageLink } from './copyLink'
import { openHistoryAction } from './history/openHistory'
import { LOAD_ORDER } from './loadOrder'
import {
    addLoadNotice,
    setLocalDataOpener,
    type NoticeAction,
    type NoticeSeverity,
} from './notification'
import { restoreStored } from './restoreStored'
import { openSettings } from './settings/openSettings'
import { copySourceName, shownName } from './shownName'
import { restoreCopy } from './switch'

// What this load found (the events of `local/startup/events.ts`) as the start-up pill's load
// notices, with their actions (Part 1 §1.4.3).

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

const restoreSession = (sessionId: string, name?: ShownName): NoticeAction => ({
    label: () => i18n.value.open.restoreIt,
    run: () => {
        void restoreStored(sessionId, 'restore', name)
    },
})

const chooseAudio: NoticeAction = {
    label: () => i18n.value.notice.chooseAudio,
    run: () => {
        void changeBgm()
    },
}

type Line = {
    order: number
    message: () => string
    action?: NoticeAction
    severity?: NoticeSeverity
}

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
            from === undefined
                ? // Without the time it was continued from, only that it was.
                  () => interpolateRaw(load().continuedUndated, shownName(name))
                : name.name.kind === 'date'
                  ? () => interpolateRaw(load().continuedUntitled, formatDateInSentence(from))
                  : () =>
                        interpolateRaw(
                            load().continued,
                            shownName(name),
                            formatDateInSentence(from),
                        ),
        action: { ...openHistoryAction(), label: () => load().openHistory },
    }),
    storageCleared: () => ({
        order: LOAD_ORDER.storageCleared,
        severity: 'warning',
        message: () => load().cleared,
    }),
    journalKept: (event) => ({
        order: LOAD_ORDER.journalKept,
        severity: 'warning',
        message: interpolate(() => load().journalKept, quoted(event.name)),
        action: restoreSession(event.sessionId, event.name),
    }),
    unsavedRecovered: (event) => ({
        order: LOAD_ORDER.unsavedRecovered,
        severity: 'info',
        message: () => load().fallback,
        action: restoreSession(event.sessionId),
    }),
    unsavedInLocalData: () => ({
        order: LOAD_ORDER.unsavedInLocalData,
        severity: 'warning',
        message: () => load().fallbackLocal,
        action: localData,
    }),
    migrationFailed: () => ({
        order: LOAD_ORDER.migrationFailed,
        severity: 'warning',
        message: () => load().migrationFailed,
        action: localData,
    }),
    migrated: (event) => ({
        order: LOAD_ORDER.migrated,
        // Kept as a session of its own when another session opened (§1.4.3). Both forms are
        // confirmations, so neither carries a severity.
        message: interpolate(
            () => (event.opened ? load().autoSave : load().autoSaveKept),
            quoted(event.name),
        ),
    }),
    migratedRevision: () => ({
        order: LOAD_ORDER.migratedRevision,
        severity: 'warning',
        // Today's warning on an older engine revision (D18).
        message: () => i18n.value.commands.open.revision.older,
    }),
    journalRecovered: (event) => ({
        order: LOAD_ORDER.journalRecovered,
        message: interpolate(() => load().journal, quoted(event.name)),
    }),
    journalLater: () => ({
        order: LOAD_ORDER.journalLater,
        severity: 'warning',
        message: () => load().journalLater,
    }),
    journalFailed: () => ({
        order: LOAD_ORDER.journalFailed,
        severity: 'warning',
        message: () => load().journalFailed,
        action: localData,
    }),
    journalsFull: () => ({
        order: LOAD_ORDER.journalsFull,
        severity: 'warning',
        message: () => load().journalsFull,
        action: localData,
    }),
    notOpened: ({ which, why }) => ({
        order: LOAD_ORDER.notOpened,
        severity: 'warning',
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
        severity: 'info',
        message: interpolate(() => load().openElsewhere, quoted(event.name)),
        action: restoreAsCopy(event.sessionId),
    }),
    deletedElsewhere: () => ({
        order: LOAD_ORDER.deletedElsewhere,
        severity: 'warning',
        message: () => load().sessionDeleted,
    }),
    separateCopy: (event) => ({
        order: LOAD_ORDER.separateCopy,
        severity: 'info',
        message: interpolate(
            () =>
                event.maybe
                    ? i18n.value.notice.sameFileMaybeElsewhere
                    : i18n.value.notice.sameFileElsewhere,
            () => copySourceName(event.of),
        ),
    }),
    bgmNotLoaded: () => ({
        order: LOAD_ORDER.bgmNotLoaded,
        severity: 'info',
        message: () => load().bgmNotLoaded,
        action: chooseAudio,
    }),
}

/** The load notice for an event. */
export const lineOf = (event: LoadEvent): Line =>
    (loadNoticeOf[event.kind] as (event: LoadEvent) => Line)(event)

const add = (event: LoadEvent) => {
    const { message, action, order, severity } = lineOf(event)
    addLoadNotice(message, action, order, severity)
}

// Events found before this module loaded come first.
for (const event of loadEvents.value) add(event)
onLoadEvent(add)

// An app’s built-in browser, best effort (§1.4.3, §1.6.10): said at every load it is found, and not
// a load event, which are what the storage startup found.
if (platform.capabilities.likelyInAppBrowser)
    addLoadNotice(
        () => load().inAppBrowser,
        {
            label: () => load().copyLink,
            run: () => {
                void copyPageLink()
            },
        },
        LOAD_ORDER.inAppBrowser,
        'warning',
    )
