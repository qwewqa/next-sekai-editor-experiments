import { shallowReactive } from 'vue'
import {
    addToFolders,
    buildFolderTree,
    copyName,
    entriesInTreeOrder,
    flattenFolderTree,
    folderOfEntry,
    insertCopiesInTree,
    insertFolderInTree,
    moveEntriesInTree,
    moveEntryInTree,
    moveFolderInTree,
    numberedName,
    removeEntriesFromTree,
    removeFolderFromTree,
    stepEntryInTree,
    stepFolderInTree,
    ungroupInTree,
    type FolderId,
    type FolderMember,
    type Folders,
    type FolderTreeItem,
    type FolderTreeRef,
} from '../../../chart/folders'
import { pushState, state } from '../../../history'
import { createHistoryOperation } from '../../../history/createHistoryOperation'
import {
    captureName,
    type NativeCounts,
    type NativeOperationInput,
    type OwnerReference,
} from '../../../history/operations'
import { onResetState } from '../../../history/resetHooks'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import ConfirmModal from '../../../modals/ConfirmModal.vue'
import type { State } from '../../../state'
import { optionalCounts, ownerCountsOf } from '../../../state/operations/historyReceipts'
import { inlineName } from '../../../utils/inlineName'
import { interpolateRaw } from '../../../utils/interpolate'
import { formatCount } from '../../../utils/size'
import { createAsyncEditGuard } from '../../asyncEditGuard'
import { notify } from '../../notification'
import { view } from '../../view'
import { normalizeName } from './model'
import { ownedCounts, type OwnerKey } from './objects'

/**
 * Collapsed folders. Collapsing is a view choice, never an edit: it stays out
 * of history and the file, and a new chart starts with every folder open.
 * Removed folders stay listed, so an undo brings them back as they were.
 */
export const collapsedFolders = shallowReactive(new Set<FolderId>())

onResetState(() => {
    collapsedFolders.clear()
})

export const isFolderExpanded = (id: FolderId) => !collapsedFolders.has(id)

export const setFolderExpanded = (id: FolderId, expanded: boolean) => {
    if (expanded) collapsedFolders.delete(id)
    else collapsedFolders.add(id)
}

/** Where an entry goes: in a folder before a member (or at its end), or loose. */
export type EntryPlace<K> =
    { folder: FolderId; before?: K } | { folder?: undefined; before?: FolderTreeRef<K> }

export type FolderStrings = {
    /** Moving an entry within its folder or the top level. */
    movedEntry: string
    deleteFolderTitle: string
    deleteFolderMessage: string
    /** Moving selected entries ({0}: their count) into a folder ({1}), or out. */
    movedSelectedInto: string
    movedSelectedOut: string
    /** Duplicating an entry ({0}: its name), or several ({0}: their count). */
    duplicated: string
    duplicatedSelected: string
    /** Duplicating selected folders ({0}: their count) and entries ({1}: all copied). */
    duplicatedSelectedFolders: string
    /** Deleting selected entries ({0}: their count), or folders ({0}) and entries ({1}). */
    deletedSelected: string
    deletedSelectedFolders: string
}

/** Folder editing for one collection; every change is one undoable step. */
export type FolderOps<K> = ReturnType<typeof createFolderOps<K, FolderMember & { name: string }>>

type FolderReference = Extract<NativeOperationInput, { id: 'nse.owner.ungroup' }>['data']['target']

/** What removing entries took: the state, the chart objects they owned and any default entry made. */
export type EntryRemoval = {
    state: State
    objects: NativeCounts
    /** The default entry created when the last one went. */
    replacement?: OwnerReference
}

// A declaration, so groups and stages can build their ops while this module is still loading.
export function createFolderOps<K, V extends FolderMember & { name: string }>(config: {
    entries: () => ReadonlyMap<K, V>
    folders: () => Folders
    /** The other kind's folders, whose ids new folders never take. */
    otherFolders: () => Folders
    /** The state with these entries and folders. */
    withData: (state: State, entries: Map<K, V>, folders: Folders) => State
    /** The state without these entries and their objects, keeping at least one entry. */
    removeEntries: (ids: ReadonlySet<K>) => EntryRemoval
    entriesOf: (state: State) => ReadonlyMap<K, V>
    /** Adds an entry with this name and data to the map, returning its id. */
    addEntry: (entries: Map<K, V>, name: string, value: V) => K
    /** The state with copies of these entries' objects, owned by their copies, and how many. */
    duplicateObjects: (
        state: State,
        copies: ReadonlyMap<K, K>,
    ) => { state: State; objects: NativeCounts }
    owner: OwnerKey
    strings: () => FolderStrings
}) {
    const tree = () => buildFolderTree(config.entries(), config.folders())

    const nameOf = (id: K) => config.entries().get(id)?.name ?? ''
    const folderName = (id: FolderId) => config.folders().get(id)?.name ?? ''
    const domain = config.owner === 'groupId' ? 'group' : 'stage'
    const folderKind = domain === 'group' ? 'groupFolder' : 'stageFolder'
    const reference = (id: FolderId): FolderReference => ({
        kind: folderKind,
        id,
        name: captureName(folderName(id)),
    })
    const entryReference = (id: K): OwnerReference => ({
        kind: domain,
        id: id as unknown as number,
        name: captureName(nameOf(id)),
    })
    const counts = (entries: number, folders = 0) => ownerCountsOf(domain, entries, folders)
    /** An entry deletion's data: what went, with its chart objects and any default entry made. */
    const deletion = (
        removed: NonNullable<ReturnType<typeof counts>>,
        removal: Pick<EntryRemoval, 'objects' | 'replacement'>,
        target?: OwnerReference,
    ) =>
        ({
            id: 'nse.owner.delete',
            data: {
                domain,
                removed,
                ...(target ? { target } : {}),
                ...optionalCounts('objects', removal.objects),
                ...(removal.replacement ? { replacement: removal.replacement } : {}),
            },
        }) as const
    const moveInput = (
        id: K,
        before: readonly FolderTreeItem<K>[],
        next: readonly FolderTreeItem<K>[],
    ): NativeOperationInput => {
        const from = folderOfEntry(before, id)?.id
        const to = folderOfEntry(next, id)?.id
        return {
            id: 'nse.owner.move',
            data: {
                target: entryReference(id),
                destination: to === undefined ? null : reference(to),
                category:
                    to !== from ? (to === undefined ? 'outOfFolder' : 'intoFolder') : 'reorder',
                fromIndex: entriesInTreeOrder(before).indexOf(id),
                toIndex: entriesInTreeOrder(next).indexOf(id),
            },
        }
    }

    const commit = (
        next: readonly FolderTreeItem<K>[],
        input: NativeOperationInput,
        folders: Folders = config.folders(),
        base: State = state.value,
    ) => {
        const flat = flattenFolderTree(next, config.entriesOf(base), folders)
        const operation = createHistoryOperation(input)
        const pushed = pushState(operation, config.withData(base, flat.entries, flat.folders))
        if (pushed) notify(() => operation.fallback.text)
    }

    /** "#1", "#2", … as new groups and stages are named. */
    const newName = () => numberedName([...config.folders().values()].map(({ name }) => name))

    /**
     * Copies entries and folders with their objects in one step. Copies of the
     * copied folders' members go in the folder copies and keep their names.
     */
    const duplicateIn = (
        ids: readonly K[],
        source: OwnerReference | undefined,
        folderCopies: ReadonlyMap<FolderId, FolderId> = new Map(),
        folders: Folders = config.folders(),
    ) => {
        const entries = new Map(config.entries())
        const taken = new Set([...entries.values()].map(({ name }) => name))
        const kept = new Set([...folderCopies.keys()].flatMap(members))
        const copies = new Map<K, K>()
        for (const id of entriesInTreeOrder(tree())) {
            if (!kept.has(id) && !ids.includes(id)) continue
            const value = entries.get(id)
            if (!value) continue
            const name = kept.has(id)
                ? value.name
                : copyName(value.name, taken, i18n.value.workspace.manager.copyName)
            taken.add(name)
            copies.set(id, config.addEntry(entries, name, value))
        }
        const created = counts(copies.size, folderCopies.size)
        // Nothing was copied, so there is no step.
        if (!created) return copies
        const { state: base, objects } = config.duplicateObjects(
            config.withData(state.value, entries, config.folders()),
            copies,
        )
        commit(
            insertCopiesInTree(tree(), copies, folderCopies),
            {
                id: 'nse.owner.duplicate',
                data: {
                    domain,
                    created,
                    ...(source ? { source } : {}),
                    ...optionalCounts('objects', objects),
                },
            },
            folders,
            base,
        )
        return copies
    }

    /** Adds copies of folders to the map, named as copies, returning them by source. */
    const copyFolders = (folders: Folders, ids: readonly FolderId[]) => {
        const names = new Set([...folders.values()].map(({ name }) => name))
        const copies = new Map<FolderId, FolderId>()
        for (const id of ids) {
            const folder = folders.get(id)
            if (!folder) continue
            const name = copyName(folder.name, names, i18n.value.workspace.manager.copyName)
            names.add(name)
            copies.set(id, addToFolders(folders, config.otherFolders(), name))
        }
        return copies
    }

    const members = (id: FolderId) =>
        tree().find(
            (item): item is Extract<FolderTreeItem<K>, { type: 'folder' }> =>
                item.type === 'folder' && item.id === id,
        )?.members ?? []

    return {
        tree,
        members,
        name: folderName,
        reference,

        /**
         * Adds a folder: at the end, or holding entries where the first of them
         * was (after the folder it leaves). Returns its id.
         */
        create(held?: ReadonlySet<K>) {
            const folders: Folders = new Map(config.folders())
            const name = newName()
            const id = addToFolders(folders, config.otherFolders(), name)
            let next = tree()
            const entry = held && entriesInTreeOrder(next).find((id) => held.has(id))
            if (!held || entry === undefined) {
                next = insertFolderInTree(next, id)
            } else {
                const holder = folderOfEntry(next, entry)
                const at = next.findIndex((item) =>
                    holder
                        ? item.type === 'folder' && item.id === holder.id
                        : item.type === 'entry' && item.id === entry,
                )
                const after = next[at + (holder ? 1 : 0)]
                next = insertFolderInTree(
                    next,
                    id,
                    after && ({ type: after.type, id: after.id } as FolderTreeRef<K>),
                )
                next = moveEntriesInTree(next, held, id) ?? next
            }
            commit(
                next,
                {
                    id: 'nse.owner.create',
                    data: {
                        target: { kind: folderKind, id, name: captureName(name) },
                        destination: null,
                        gathered: next.flatMap((item) =>
                            item.type === 'folder' && item.id === id ? item.members : [],
                        ).length,
                    },
                },
                folders,
            )
            return id
        },

        rename(id: FolderId, value: string) {
            const folder = config.folders().get(id)
            const name = normalizeName(value)
            if (!folder || !name || name === folder.name) return
            const folders: Folders = new Map(config.folders())
            folders.set(id, { ...folder, name })
            commit(
                tree(),
                {
                    id: 'nse.owner.rename',
                    data: {
                        target: reference(id),
                        before: captureName(folder.name),
                        after: captureName(name),
                    },
                },
                folders,
            )
        },

        /** Moves an entry into, within or out of folders. */
        placeEntry(id: K, place: EntryPlace<K>) {
            const before = tree()
            const next = moveEntryInTree(before, id, place)
            if (!next) return
            commit(next, moveInput(id, before, next))
        },

        /** Moves entries to a folder's end, or out of their folders, as one step; those already there stay put. */
        placeEntries(ids: ReadonlySet<K>, folder: FolderId | undefined) {
            const before = tree()
            const next = moveEntriesInTree(before, ids, folder)
            if (!next) return
            const targets = [...ids].filter(
                (id) =>
                    config.entries().has(id) &&
                    folderOfEntry(before, id)?.id !== folderOfEntry(next, id)?.id,
            ).length
            commit(next, {
                id: 'nse.owner.moveMany',
                data: {
                    domain,
                    targets,
                    destination: folder === undefined ? null : reference(folder),
                },
            })
        },

        /** Steps an entry, crossing folder edges; collapsed folders are passed whole. */
        stepEntry(id: K, offset: -1 | 1) {
            const before = tree()
            const next = stepEntryInTree(before, id, offset, isFolderExpanded)
            if (!next) return
            commit(next, moveInput(id, before, next))
        },

        canStepEntry: (id: K, offset: -1 | 1) =>
            !!stepEntryInTree(tree(), id, offset, isFolderExpanded),

        placeFolder(id: FolderId, before?: FolderTreeRef<K>) {
            const previous = tree()
            const next = moveFolderInTree(previous, id, before)
            if (!next) return
            commit(next, {
                id: 'nse.owner.move',
                data: {
                    target: reference(id),
                    destination: null,
                    category: 'reorder',
                    fromIndex: previous.findIndex(
                        (item) => item.type === 'folder' && item.id === id,
                    ),
                    toIndex: next.findIndex((item) => item.type === 'folder' && item.id === id),
                },
            })
        },

        stepFolder(id: FolderId, offset: -1 | 1) {
            const previous = tree()
            const next = stepFolderInTree(previous, id, offset)
            if (!next) return
            commit(next, {
                id: 'nse.owner.move',
                data: {
                    target: reference(id),
                    destination: null,
                    category: 'reorder',
                    fromIndex: previous.findIndex(
                        (item) => item.type === 'folder' && item.id === id,
                    ),
                    toIndex: next.findIndex((item) => item.type === 'folder' && item.id === id),
                },
            })
        },

        canStepFolder: (id: FolderId, offset: -1 | 1) => !!stepFolderInTree(tree(), id, offset),

        /** Duplicates entries with their objects; returns the copies in order. */
        duplicate(ids: ReadonlySet<K>): K[] {
            const sources = entriesInTreeOrder(tree()).filter((id) => ids.has(id))
            if (!sources.length) return []
            const copies = duplicateIn(
                sources,
                sources.length === 1 ? entryReference(sources[0] as K) : undefined,
            )
            return sources.flatMap((id) => {
                const copy = copies.get(id)
                return copy === undefined ? [] : [copy]
            })
        },

        /** Duplicates a folder with its members and their objects; returns the copy. */
        duplicateFolder(id: FolderId) {
            const folders: Folders = new Map(config.folders())
            const copies = copyFolders(folders, [id])
            const copy = copies.get(id)
            if (copy === undefined) return
            duplicateIn([], reference(id), copies, folders)
            return copy
        },

        /**
         * Duplicates entries and whole folders as one step, each copy after its
         * source; returns the entry copies in order and the folder copies.
         */
        duplicateMany(ids: readonly K[], folderIds: readonly FolderId[]) {
            const folders: Folders = new Map(config.folders())
            const folderCopies = copyFolders(folders, folderIds)
            const sources = entriesInTreeOrder(tree()).filter((id) => ids.includes(id))
            if (!sources.length && !folderCopies.size) return { entries: [], folders: [] }
            const [only] = folderCopies.keys()
            const source =
                !folderCopies.size && sources.length === 1
                    ? entryReference(sources[0] as K)
                    : !sources.length && folderCopies.size === 1 && only !== undefined
                      ? reference(only)
                      : undefined
            const copies = new Set(duplicateIn(sources, source, folderCopies, folders).values())
            return {
                entries: entriesInTreeOrder(tree()).filter((id) => copies.has(id)),
                folders: [...folderCopies.values()],
            }
        },

        /** Removes a folder, keeping its members where they are. */
        ungroup(id: FolderId) {
            const target = reference(id)
            const released = members(id).length
            const folders: Folders = new Map(config.folders())
            folders.delete(id)
            commit(
                ungroupInTree(tree(), id),
                { id: 'nse.owner.ungroup', data: { target, released } },
                folders,
            )
        },

        /** Deletes a folder with its members and their objects, after confirming. */
        async remove(id: FolderId, signal?: AbortSignal) {
            const guard = createAsyncEditGuard(signal)
            try {
                if (!guard.isCurrent() || !config.folders().has(id)) return false
                const name = folderName(id)
                const ids = new Set(members(id))
                const objects = [...ids].reduce(
                    (sum, member) =>
                        sum + (ownedCounts(config.owner).get(member as unknown as number) ?? 0),
                    0,
                )
                if (ids.size) {
                    const confirmed = await showModal(ConfirmModal, {
                        title: () => config.strings().deleteFolderTitle,
                        message: () =>
                            interpolateRaw(
                                config.strings().deleteFolderMessage,
                                inlineName(name),
                                formatCount(ids.size),
                                formatCount(objects),
                            ),
                        confirm: () => i18n.value.modals.confirm.delete,
                        destructive: true,
                    })
                    if (!confirmed || !config.folders().has(id)) return false
                }
                if (!guard.isCurrent()) return false
                const target = reference(id)
                const removed = counts(
                    [...ids].filter((member) => config.entries().has(member)).length,
                    config.folders().has(id) ? 1 : 0,
                )
                // The folder is checked to exist just above.
                if (!removed) return false
                const next = removeEntriesFromTree(removeFolderFromTree(tree(), id), ids)
                const removal: EntryRemoval = ids.size
                    ? config.removeEntries(ids)
                    : { state: state.value, objects: {} }
                const folders: Folders = new Map(config.folders())
                folders.delete(id)
                commit(next, deletion(removed, removal, target), folders, removal.state)
                if (ids.size)
                    view.entities = {
                        hovered: [],
                        creating: [],
                    }
                return true
            } finally {
                guard.dispose()
            }
        },

        /** The state with an entry moved to the end of a folder, as part of another edit. */
        placedIn(base: State, id: K, folder: FolderId): State {
            const entries = config.entriesOf(base)
            const next = moveEntryInTree(buildFolderTree(entries, config.folders()), id, {
                folder,
            })
            if (!next) return base
            const flat = flattenFolderTree(next, entries, config.folders())
            return config.withData(base, flat.entries, flat.folders)
        },

        /** Drops deleted entries from the tree, keeping folders in place. */
        commitRemoval(ids: ReadonlySet<K>, removal: EntryRemoval, target: OwnerReference) {
            const removed = counts(ids.size)
            if (!removed) return
            commit(
                removeEntriesFromTree(tree(), ids),
                deletion(removed, removal, target),
                config.folders(),
                removal.state,
            )
        },

        /**
         * Deletes entries with their objects, and folders, as one step, keeping
         * at least one entry. A deleted folder's members are among the entries.
         */
        removeMany(entryIds: ReadonlySet<K>, folderIds: ReadonlySet<FolderId> = new Set()) {
            const ids = new Set([...entryIds].filter((id) => config.entries().has(id)))
            const gone = new Set([...folderIds].filter((id) => config.folders().has(id)))
            if (!ids.size && !gone.size) return
            const [only] = gone
            const target =
                gone.size === 1 &&
                only !== undefined &&
                members(only).length === ids.size &&
                members(only).every((id) => ids.has(id))
                    ? reference(only)
                    : !gone.size && ids.size === 1
                      ? entryReference([...ids][0] as K)
                      : undefined
            const removed = counts(ids.size, gone.size)
            if (!removed) return
            const removal: EntryRemoval = ids.size
                ? config.removeEntries(ids)
                : { state: state.value, objects: {} }
            const folders: Folders = new Map(config.folders())
            for (const id of gone) folders.delete(id)
            commit(
                removeEntriesFromTree(tree(), ids).filter(
                    (item) => item.type !== 'folder' || !gone.has(item.id),
                ),
                deletion(removed, removal, target),
                folders,
                removal.state,
            )
        },
    }
}
