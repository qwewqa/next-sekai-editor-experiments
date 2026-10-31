import {
    directLevel,
    isEmptyInventory,
    readInventory,
    type Inventory,
    type PackageLevel,
} from '../../../files/package/inventory'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import InfoModal from '../../../modals/InfoModal.vue'
import LoadingModal from '../../../modals/LoadingModal.vue'
import { AssetImportError } from '../../../preview/assets/files/errors'
import { importMessage } from '../../../preview/assets/files/importText'
import { registerOpenedPackage } from '../../save/openedPackages'
import { confirmSwitch } from '../../switch'
import { withSwitchRequest, type SwitchRequest } from '../../switchRequest'
import { openPackageLevel } from './packageLevel'
import { dropOpen, endOpen } from './report'

// Open's package flow: the package is registered so Save and Export refuse it, its lists are
// read in the loading dialog, and then one level opens directly or the list shows.

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

/** A listing failure as the loading dialog words it. */
const listingError = (error: unknown) =>
    new Error(
        importMessage(
            error instanceof AssetImportError ? error : new AssetImportError('fileUnreadable'),
        ),
        { cause: error },
    )

/** Reads a package's lists in the Open loading dialog; undefined when it failed or was cancelled. */
const listPackage = async (file: File) => {
    let inventory: Inventory | undefined
    await showModal(LoadingModal, {
        title: () => i18n.value.commands.open.dialogTitle,
        async *task(signal: AbortSignal) {
            yield () => i18n.value.commands.open.loading
            try {
                const read = await readInventory(file, signal)
                if (!signal.aborted) inventory = read
            } catch (error) {
                if (isAbort(error) || signal.aborted) return
                throw listingError(error)
            }
        },
    })
    return inventory
}

/**
 * Opens one level in a switch: the request given while it is current, else a new one, confirmed
 * first, so a press never acts on stale consent and is never a silent no-op.
 */
export const openLevelIn = async (
    request: SwitchRequest | undefined,
    inventory: Inventory,
    level: PackageLevel,
) => {
    if (request?.isCurrent()) return openPackageLevel(inventory, level, request)
    return withSwitchRequest(undefined, async (fresh) => {
        if (!(await confirmSwitch()) || !fresh.isCurrent()) return false
        return openPackageLevel(inventory, level, fresh)
    })
}

/**
 * The package flow, from detection on. `request` is the Open command's, already confirmed; without
 * it every switch is confirmed just before it happens.
 */
export const openPackage = async (
    file: File,
    handle: FileSystemFileHandle | undefined,
    request: SwitchRequest | undefined,
    showList: (inventory: Inventory, request: SwitchRequest | undefined) => Promise<void>,
) => {
    // Before anything else is read: a list-only visit or a failed open is covered too.
    if (handle) registerOpenedPackage(handle, file)
    const inventory = await listPackage(file)
    if (!inventory) {
        dropOpen()
        return
    }
    if (isEmptyInventory(inventory)) {
        dropOpen()
        await showModal(InfoModal, {
            title: () => i18n.value.commands.open.dialogTitle,
            message: () => i18n.value.open.package.empty,
        })
        return
    }
    const level = directLevel(inventory)
    if (level) {
        await openLevelIn(request, inventory, level)
        endOpen('cancelled')
        return
    }
    // Browsing the list is not an open.
    dropOpen()
    await showList(inventory, request)
}
