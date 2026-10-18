import { journalHandlers } from '../journal/handlers'
import { changeHandlers } from './changeHandlers'
import { flushHandlers } from './flushHandlers'
import { createContext } from './handlers'
import { peekHandlers } from './peekHandlers'
import { saveHandlers } from './saveHandlers'
import { serve, type Endpoint } from './rpc'
import { startupHandlers } from './startupHandlers'
import { timelineHandlers } from './timelineHandlers'
import { userAssetHandlers } from './userAssets'

// The storage worker's entry (Part 1 §1.6.5): one dedicated worker per tab, written as a module
// worker and built as iife, so the build emits a classic worker (Firefox 105 has no module
// workers). No dynamic imports in here: an iife build can't split.

const scope = self as unknown as Endpoint

let emit: (event: string, data?: unknown) => void = () => undefined
const { context, handlers: coreHandlers } = createContext((event, data) => {
    emit(event, data)
})

const handlers = {
    ...coreHandlers,
    ...flushHandlers(context),
    ...userAssetHandlers(context),
    ...journalHandlers(context),
    ...startupHandlers(context),
    ...timelineHandlers(context),
    ...peekHandlers(context),
    ...changeHandlers(context),
    ...saveHandlers(context),
}

export type StorageHandlers = typeof handlers

emit = serve(scope, handlers)
