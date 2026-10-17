import { languageTag } from '../../../i18n/plural'
import { settings } from '../../../settings'

const tag = () => languageTag(settings.locale)

/** A file size as "12.4 kB" or "1.2 MB", in the locale's own units; a small file is "0.2 kB". */
export const formatSize = (bytes: number) => {
    const mega = bytes >= 1000 * 1000
    return new Intl.NumberFormat(tag(), {
        style: 'unit',
        unit: mega ? 'megabyte' : 'kilobyte',
        unitDisplay: 'short',
        maximumFractionDigits: 1,
    }).format(Math.max(bytes / (mega ? 1000 * 1000 : 1000), bytes ? 0.1 : 0))
}

/** A file time as "Oct 16, 2:41 PM". */
export const formatTime = (ms: number) =>
    new Intl.DateTimeFormat(tag(), {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    }).format(ms)
