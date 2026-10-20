import {
    describeEntry,
    describeOperation,
    message,
    type OperationTextContext,
} from '../../history/operationPresentation'
import { decodeOperation } from '../../history/operations'
import type { Entry } from './rows'

/**
 * A boundary divider's label (Part 1 §1.4.10.5), from its own `continue` entry: an open reads
 * "Opened coconut.nxsp", a continuation "Continued from" the time its operation holds, to the
 * minute. An opened file is one session with no parent links, so `from` (the parent's newest
 * entry, from storage) is only for an operation with no time, and the entry's own time is never
 * the time it continued from.
 */
export const dividerLabel = (
    entry: Entry,
    context: OperationTextContext,
    minute: (at: number) => string,
) => {
    const decoded = entry.operation === undefined ? undefined : decodeOperation(entry.operation)
    const operation = decoded?.status === 'known' ? decoded.operation : undefined
    const continued = (at: number) =>
        message(context, context.strings.history.continuedFrom, minute(at))
    if (
        operation?.id === 'nse.continue' &&
        !Number.isNaN(new Date(operation.data.fromTime).getTime())
    )
        return continued(operation.data.fromTime)
    if (operation?.id === 'nse.origin') return describeOperation(operation, context)
    if (entry.from !== undefined) return continued(entry.from)
    return describeEntry(entry, context)
}
