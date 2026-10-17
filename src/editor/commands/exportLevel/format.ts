import { languageTag } from '../../../i18n/plural'
import { settings } from '../../../settings'

const tag = () => languageTag(settings.locale)

/** A file size as "12.4 kB" in the locale's own units. */
export const formatSize = (bytes: number) => {
    const [value, unit] =
        bytes < 1000
            ? [bytes, 'byte']
            : bytes < 1000 * 1000
              ? [bytes / 1000, 'kilobyte']
              : [bytes / (1000 * 1000), 'megabyte']
    return new Intl.NumberFormat(tag(), {
        style: 'unit',
        unit,
        unitDisplay: 'short',
        maximumFractionDigits: unit === 'byte' ? 0 : 1,
    }).format(value)
}

/** A file time as "Oct 16, 2:41 PM". */
export const formatTime = (ms: number) =>
    new Intl.DateTimeFormat(tag(), {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    }).format(ms)
