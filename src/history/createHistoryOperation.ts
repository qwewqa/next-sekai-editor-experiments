import { hostZone } from '../calendar/calendar'
import { i18n } from '../i18n'
import { settings } from '../settings'
import { describeOperation } from './operationPresentation/format'
import type { OperationTextContext } from './operationPresentation/types'
import { createOperation, type NativeOperationInput } from './operations'

/**
 * The text context for callers outside History: the engine's zone and clock at the moment of the
 * call. History surfaces build theirs with `historyOperationContext`, from the History clock.
 */
export const getHistoryOperationContext = (): OperationTextContext => ({
    locale: settings.locale,
    strings: i18n.value,
    now: Date.now(),
    zone: hostZone(),
})

export const createHistoryOperation = (input: NativeOperationInput) => {
    const context = getHistoryOperationContext()
    return createOperation(input, {
        locale: context.locale,
        describe: (operation) => describeOperation(operation, context),
    })
}
