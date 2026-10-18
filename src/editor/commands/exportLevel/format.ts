import { formatDateTime } from '../../../i18n/dateTime'
import { settings } from '../../../settings'

export { formatSize } from '../../../utils/size'

/** A file time as "Oct 16, 2:41 PM". */
export const formatTime = (ms: number) => formatDateTime(settings.locale, ms)
