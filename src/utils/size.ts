import { languageTag } from '../i18n/plural'

// Set by i18n, so this module stays off the settings import cycle.
let currentLocale = () => 'en'

/** Names the locale sizes are shown in. */
export const setSizeLocale = (locale: () => string) => {
    currentLocale = locale
}

/**
 * A size as "12.4 kB", "1.2 MB" or "123 MB", for every size the editor shows (Part 1 §1.4.7):
 * decimal units (1 MB = 1,000,000 bytes) in the UI locale, with at most one decimal below 100
 * of a unit and none from 100. A small file is "0.2 kB".
 */
export const formatSize = (bytes: number, locale: string = currentLocale()) => {
    const [unit, scale] =
        bytes >= 1e9 ? ['gigabyte', 1e9] : bytes >= 1e6 ? ['megabyte', 1e6] : ['kilobyte', 1e3]
    const value = Math.max(bytes / scale, bytes ? 0.1 : 0)
    return (
        new Intl.NumberFormat(languageTag(locale), {
            style: 'unit',
            unit,
            unitDisplay: 'short',
            maximumFractionDigits: value >= 99.95 ? 0 : 1,
        })
            .format(value)
            // The unit stays with its number when the line wraps.
            .replaceAll(' ', '\u00a0')
    )
}

/** A count in the UI locale's own grouping: "1,840". */
export const formatCount = (count: number, locale: string = currentLocale()) =>
    new Intl.NumberFormat(languageTag(locale)).format(count)

/** A decimal such as a speed in the UI locale: "0,5" in French, at most three fractions. */
export const formatDecimal = (value: number, locale: string = currentLocale()) =>
    new Intl.NumberFormat(languageTag(locale), { maximumFractionDigits: 3 }).format(value)
