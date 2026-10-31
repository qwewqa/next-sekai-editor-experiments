import {
    directLevel,
    isEmptyInventory,
    readInventory,
    type Inventory,
    type PackageLevel,
} from '../../../files/package/inventory'
import { session } from '../../../history/session'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import InfoModal from '../../../modals/InfoModal.vue'
import LoadingModal from '../../../modals/LoadingModal.vue'
import { platform } from '../../../platform'
import { packageUrls } from '../../../preview/assets'
import { AssetImportError } from '../../../preview/assets/files/errors'
import { identifyAssets, type AssetIdentity } from '../../../preview/assets/files/identity'
import { importMessage } from '../../../preview/assets/files/importText'
import { workerStore } from '../../../preview/assets/files/store'
import type { BundledId } from '../../../preview/assets/types'
import { getFilename } from '../../../utils/file'
import { registerOpenedPackage } from '../../save/openedPackages'
import { confirmSwitch } from '../../switch'
import { withSwitchRequest, type SwitchRequest } from '../../switchRequest'
import { openPackageLevel } from './packageLevel'
import { createPackageList } from './packageList'
import PackageListModal from './PackageListModal.vue'
import { dropOpen, endOpen, startOpen } from './report'

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

type Listed = { inventory: Inventory; identities: readonly AssetIdentity[] }

/**
 * Reads a package's lists in the Open loading dialog, and for a list, which assets are in Preview
 * Assets already, so no row changes under the pointer. Undefined when it failed or was cancelled.
 */
const listPackage = async (file: File) => {
    let listed: Listed | undefined
    await showModal(LoadingModal, {
        title: () => i18n.value.commands.open.dialogTitle,
        async *task(signal: AbortSignal) {
            yield () => i18n.value.commands.open.loading
            let inventory: Inventory
            try {
                inventory = await readInventory(file, signal)
            } catch (error) {
                if (isAbort(error) || signal.aborted) return
                throw listingError(error)
            }
            const listing = !isEmptyInventory(inventory) && !directLevel(inventory)
            let identities: AssetIdentity[] = []
            try {
                if (listing)
                    identities = await identifyAssets(
                        inventory.pkg,
                        inventory.assets,
                        {
                            store: workerStore,
                            hasDefault: platform.capabilities.defaultAssets,
                            bundled: new Set(
                                (['skin2', 'effect2'] as BundledId[]).filter(
                                    (id) => packageUrls[id],
                                ),
                            ),
                        },
                        signal,
                    )
            } catch (error) {
                // Cancel stops the reads; nothing else rejects.
                if (signal.aborted) return
                throw error
            }
            if (!signal.aborted) listed = { inventory, identities }
        },
    })
    return listed
}

/**
 * Opens one level in a switch: the request given while it is current, else a new one, confirmed
 * first, so a press never acts on stale consent and is never a silent no-op.
 */
const openLevelIn = async (
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
 * The list, shown again with the same state after an Open that failed or was cancelled, unless a
 * newer switch took over. Closing it ends the flow.
 */
const showList = async (
    file: File,
    { inventory, identities }: Listed,
    request: SwitchRequest | undefined,
) => {
    const list = createPackageList(inventory, identities, file.name)
    try {
        for (;;) {
            const level = await showModal(
                PackageListModal,
                { title: getFilename(file), list },
                { size: 'large', cap: '34rem' },
            )
            if (!level) return
            const before = session.value.sessionId
            // Each Open in the list is an open of its own.
            startOpen(file)
            let opened = false
            try {
                opened = await openLevelIn(request, inventory, level)
            } finally {
                endOpen('cancelled')
            }
            if (opened || session.value.sessionId !== before) return
        }
    } finally {
        list.dispose()
    }
}

/**
 * The package flow, from detection on. `request` is the Open command's, already confirmed; without
 * it every switch is confirmed just before it happens.
 */
export const openPackage = async (
    file: File,
    handle: FileSystemFileHandle | undefined,
    request: SwitchRequest | undefined,
) => {
    // Before anything else is read: a list-only visit or a failed open is covered too.
    if (handle) registerOpenedPackage(handle, file)
    const listed = await listPackage(file)
    if (!listed) {
        dropOpen()
        return
    }
    const { inventory } = listed
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
        return
    }
    // Browsing the list is not an open.
    dropOpen()
    await showList(file, listed, request)
}
