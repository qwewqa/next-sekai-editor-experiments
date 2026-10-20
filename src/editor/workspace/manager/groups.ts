import type { FolderId } from '../../../chart/folders'
import { addToGroups, type GroupId } from '../../../chart/groups'
import { pushState, state } from '../../../history'
import { createHistoryOperation } from '../../../history/createHistoryOperation'
import { groupFolders, groups } from '../../../history/groups'
import { captureName } from '../../../history/operations'
import { stageFolders } from '../../../history/stages'
import { getAllEntities } from '../../../history/store'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import type { Entity } from '../../../state/entities'
import { removeNote } from '../../../state/mutations/slides/note'
import { removeTimeScale } from '../../../state/mutations/timeScale'
import { duplicateOwnedWithReceipt } from '../../../state/operations/duplicateOwned'
import { countNativeEntities } from '../../../state/operations/historyReceipts'
import { createTransaction } from '../../../state/transaction'
import GroupPropertiesModal from '../../commands/manageGroups/manageGroups/groupProperties/GroupPropertiesModal.vue'
import { notify } from '../../notification'
import { groupScope } from '../../scope'
import { view } from '../../view'
import { createFolderOps, type EntryRemoval } from './folders'
import { normalizeName, type ManagerModel } from './model'
import { survivingSelection } from './objects'

const nameOf = (groupId: GroupId) => groups.value.get(groupId)?.name ?? ''

/** Adds a group at the end, or at the end of a folder, in one step. */
export const addGroup = (folder?: FolderId) => {
    const newGroups = new Map(groups.value)
    const [groupId, name] = addToGroups(newGroups)

    const added = { ...state.value, groups: newGroups }
    const result = folder === undefined ? added : groupFolderOps.placedIn(added, groupId, folder)
    const destination = result.groups.get(groupId)?.folderId
    const operation = createHistoryOperation({
        id: 'nse.owner.create',
        data: {
            target: { kind: 'group', id: groupId, name: captureName(name) },
            destination: destination === undefined ? null : groupFolderOps.reference(destination),
            gathered: 0,
        },
    })
    pushState(operation, result)

    notify(() => operation.fallback.text)

    return groupId
}

export const renameGroup = (groupId: GroupId, value: string) => {
    const object = groups.value.get(groupId)
    const name = normalizeName(value)
    if (!object || !name || name === object.name) return

    const newGroups = new Map(groups.value)
    newGroups.set(groupId, { ...object, name })

    const operation = createHistoryOperation({
        id: 'nse.owner.rename',
        data: {
            target: { kind: 'group', id: groupId, name: captureName(object.name) },
            before: captureName(object.name),
            after: captureName(name),
        },
    })
    pushState(operation, {
        ...state.value,
        groups: newGroups,
    })

    notify(() => operation.fallback.text)
}

export const openGroupProperties = async (groupId: GroupId) => {
    await showModal(GroupPropertiesModal, {
        groupId,
    })
}

/**
 * The state without these groups and their notes and time scales, keeping at least one group,
 * with what that took: the objects removed and the default group created when the last one went.
 */
const removeGroups = (groupIds: ReadonlySet<GroupId>): EntryRemoval => {
    const transaction = createTransaction(state.value)
    const removed: Entity[] = []

    const removes: {
        [T in Entity as T['type']]: ((entity: T) => void) | undefined
    } = {
        bpm: undefined,
        timeScale(entity) {
            if (!groupIds.has(entity.groupId)) return

            removed.push(entity)
            removeTimeScale(transaction, entity)
        },

        cameraEventJoint: undefined,
        cameraEventConnection: undefined,

        stageMaskEventJoint: undefined,
        stageMaskEventConnection: undefined,

        stagePivotEventJoint: undefined,
        stagePivotEventConnection: undefined,

        stageStyleEventJoint: undefined,
        stageStyleEventConnection: undefined,

        stageTransformEventJoint: undefined,
        stageTransformEventConnection: undefined,

        note(entity) {
            if (!groupIds.has(entity.groupId)) return

            removed.push(entity)
            removeNote(transaction, entity)
        },
        connector: undefined,
    }

    for (const entity of getAllEntities()) {
        removes[entity.type]?.(entity as never)
    }

    // Keep the rest of the selection; only the deleted objects leave it.
    const newState = transaction.commit(survivingSelection('groupId', groupIds))

    newState.groups = new Map(newState.groups)
    for (const groupId of groupIds) newState.groups.delete(groupId)
    let replacement: EntryRemoval['replacement']
    if (!newState.groups.size) {
        const [id, name] = addToGroups(newState.groups)
        replacement = { kind: 'group', id, name: captureName(name) }
    }

    return { state: newState, objects: countNativeEntities(removed), replacement }
}

export const groupFolderOps = createFolderOps({
    entries: () => groups.value,
    folders: () => groupFolders.value,
    otherFolders: () => stageFolders.value,
    withData: (state, groups, groupFolders) => ({ ...state, groups, groupFolders }),
    removeEntries: removeGroups,
    entriesOf: (state) => state.groups,
    addEntry: (entries, name, entry) => {
        const { name: _, ...value } = entry
        return addToGroups(entries, name, value)[0]
    },
    duplicateObjects: (state, copies) =>
        duplicateOwnedWithReceipt(state, { key: 'groupId', copies }),
    owner: 'groupId',
    strings: () => ({
        movedEntry: i18n.value.commands.manageGroups.modal.moved,
        deleteFolderTitle: i18n.value.workspace.groups.deleteFolderTitle,
        deleteFolderMessage: i18n.value.workspace.groups.deleteFolderMessage,
        movedSelectedInto: i18n.value.workspace.groups.movedSelectedInto,
        movedSelectedOut: i18n.value.workspace.groups.movedSelectedOut,
        duplicated: i18n.value.workspace.groups.duplicated,
        duplicatedSelected: i18n.value.workspace.groups.duplicatedSelected,
        duplicatedSelectedFolders: i18n.value.workspace.groups.duplicatedSelectedFolders,
        deletedSelected: i18n.value.workspace.groups.deletedSelected,
        deletedSelectedFolders: i18n.value.workspace.groups.deletedSelectedFolders,
    }),
})

/** Deletes a group with its notes and time scales, keeping at least one group. */
export const deleteGroup = (groupId: GroupId) => {
    if (!groups.value.has(groupId)) return
    const ids = new Set([groupId])
    groupFolderOps.commitRemoval(ids, removeGroups(ids), {
        kind: 'group',
        id: groupId,
        name: captureName(nameOf(groupId)),
    })
    view.entities = {
        hovered: [],
        creating: [],
    }
}

/** Deletes groups with their objects, and folders, as one step, keeping at least one group. */
const deleteGroups = (groupIds: ReadonlySet<GroupId>, folderIds?: ReadonlySet<FolderId>) => {
    groupFolderOps.removeMany(groupIds, folderIds)
    view.entities = {
        hovered: [],
        creating: [],
    }
}

export const groupManager: ManagerModel<GroupId> = {
    entries: () => [...groups.value].map(([id, { name }]) => ({ id, name })),
    focused: () => view.groupId,
    scope: groupScope,
    strings: () => ({
        all: i18n.value.workspace.groups.all,
        showAll: i18n.value.workspace.groups.showAll,
        hideAll: i18n.value.workspace.groups.hideAll,
        add: i18n.value.workspace.groups.add,
        properties: i18n.value.commands.manageGroups.modal.properties.title,
        moveUp: i18n.value.commands.manageGroups.modal.moveUp,
        moveDown: i18n.value.commands.manageGroups.modal.moveDown,
        delete: i18n.value.commands.manageGroups.modal.delete,
        deleteFolder: i18n.value.workspace.groups.deleteFolder,
        deleteSelectedTitle: i18n.value.workspace.groups.deleteSelectedTitle,
        deleteSelectedFoldersTitle: i18n.value.workspace.groups.deleteSelectedFoldersTitle,
        deleteSelectedMessage: i18n.value.workspace.groups.deleteSelectedMessage,
        deleteSelectedFoldersMessage: i18n.value.workspace.groups.deleteSelectedFoldersMessage,
    }),
    add: addGroup,
    move: (id, offset) => {
        groupFolderOps.stepEntry(id, offset)
    },
    rename: renameGroup,
    remove: deleteGroup,
    removeMany: deleteGroups,
    openProperties: openGroupProperties,
    owner: 'groupId',
    folders: groupFolderOps,
}
