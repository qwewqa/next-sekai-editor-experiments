import { languageTag } from '../../../i18n/plural'
import { settings } from '../../../settings'

const tag = () => languageTag(settings.locale)

/**
 * A file size as "12.4 kB", "1.2 MB" or "2.1 GB", in the locale's own units; a small file is
 * "0.2 kB".
 */
export const formatSize = (bytes: number) => {
    const [unit, scale] =
        bytes >= 1e9 ? ['gigabyte', 1e9] : bytes >= 1e6 ? ['megabyte', 1e6] : ['kilobyte', 1e3]
    return new Intl.NumberFormat(tag(), {
        style: 'unit',
        unit,
        unitDisplay: 'short',
        maximumFractionDigits: 1,
    }).format(Math.max(bytes / scale, bytes ? 0.1 : 0))
}

/** A file time as "Oct 16, 2:41 PM". */
export const formatTime = (ms: number) =>
    new Intl.DateTimeFormat(tag(), {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    }).format(ms)
