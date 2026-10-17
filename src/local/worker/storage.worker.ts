import { createContext } from './handlers'
import { serve, type Endpoint } from './rpc'

// The storage worker's entry (Part 1 §1.6.5): one dedicated worker per tab, written as a module
// worker and built as iife, so the build emits a classic worker (Firefox 105 has no module
// workers). No dynamic imports in here: an iife build can't split.

const scope = self as unknown as Endpoint

let emit: (event: string, data?: unknown) => void = () => undefined
const { handlers: coreHandlers } = createContext((event, data) => {
    emit(event, data)
})

// The flush package adds its handlers here, over the same context.
const handlers = { ...coreHandlers }

export type StorageHandlers = typeof handlers

emit = serve(scope, handlers)
