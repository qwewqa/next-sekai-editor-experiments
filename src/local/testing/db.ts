import { DB_NAME, DB_VERSION, upgradeDatabase } from '../db'
import type { Tab } from './world'

let ids = 0

/** Opens this tab's connection to `nse-local-data`, creating the v1 schema on first open. */
export const openLocalData = (tab: Tab, version: number = DB_VERSION) =>
    tab.kv.open(DB_NAME, version, {
        upgrade: upgradeDatabase({
            appVersion: '0.6.0',
            randomId: () => `id-${ids++}`,
        }),
    })
