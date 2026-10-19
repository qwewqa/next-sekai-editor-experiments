import { i18n } from '../i18n'
import { settings } from '../settings'
import { describeOperation } from './operationPresentation/format'
import type { OperationTextContext } from './operationPresentation/types'
import { createOperation, type NativeOperationInput } from './operations'

export const getHistoryOperationContext = (): OperationTextContext => ({
    locale: settings.locale,
    strings: i18n.value,
    now: Date.now(),
})

export const createHistoryOperation = (input: NativeOperationInput) => {
    const context = getHistoryOperationContext()
    return createOperation(input, {
        locale: context.locale,
        describe: (operation) => describeOperation(operation, context),
    })
}
