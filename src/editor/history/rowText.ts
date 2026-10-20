import type { OperationTextContext } from '../../history/operationPresentation/types'
import { dividerLabel } from './dividerLabel'
import type { HistoryFormat } from './historyFormat'
import type { Entry } from './rows'

// The times and titles the Timeline writes on its rows (Part 1 §1.4.10.5), from the History
// format alone, so one calendar decides every date and Node tests can load them.

/** A row's time: narrow rows omit seconds. */
export const rowTime = (format: HistoryFormat, at: number, narrow: boolean) =>
    narrow ? format.clock(at) : format.clockSeconds(at)

/** The full date and time: the row's tooltip and part of its accessible name. */
export const rowWhen = (format: HistoryFormat, at: number) => format.dateTimeSeconds(at)

type RowParts = {
    /** The row's full label. */
    label: string
    flag: string | undefined
    delta?: string | undefined
}

/** A row's `title`: its label, flag and full time. */
export const rowTitle = (format: HistoryFormat, at: number, { label, flag }: RowParts) =>
    [label, flag, rowWhen(format, at)].filter(Boolean).join(' · ')

/** A row's accessible name: its label, flag, change and full time. */
export const rowName = (format: HistoryFormat, at: number, { label, flag, delta }: RowParts) =>
    [label, flag, delta, rowWhen(format, at)].filter(Boolean).join(', ')

/** A boundary divider's text; the time it continued from is written to the minute. */
export const dividerText = (format: HistoryFormat, context: OperationTextContext, entry: Entry) =>
    dividerLabel(entry, context, format.dateTime)
