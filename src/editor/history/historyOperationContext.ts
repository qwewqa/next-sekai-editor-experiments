import type { OperationTextContext } from '../../history/operationPresentation/types'
import { i18n } from '../../i18n'
import { settings } from '../../settings'
import type { Calendar } from './calendarClock'

/**
 * The text context of a History surface: the app locale and strings, and the calendar's clock and
 * zone. The only way History builds one (I-1); the engine's own zone and clock are for callers
 * outside History (`getHistoryOperationContext`).
 */
export const historyOperationContext = (cal: Calendar): OperationTextContext => ({
    locale: settings.locale,
    strings: i18n.value,
    now: cal.now,
    zone: cal.zone,
})
