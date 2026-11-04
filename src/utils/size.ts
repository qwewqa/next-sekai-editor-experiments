import { languageTag } from '../i18n/plural'

// Set by i18n, so this module stays off the settings import cycle.
let currentLocale = () => 'en'

/** Names the locale sizes are shown in. */
export const setSizeLocale = (locale: () => string) => {
    currentLocale = locale
}

// Building an Intl.NumberFormat costs far more than formatting with one, and these run in
// per-frame renders. The key set is small: a few locales times a few option sets.
const formats = new Map<string, Intl.NumberFormat>()
const numberFormat = (locale: string, options?: Intl.NumberFormatOptions) => {
    const tag = languageTag(locale)
    const key = `${tag}|${options ? JSON.stringify(options) : ''}`
    let format = formats.get(key)
    if (!format) {
        format = new Intl.NumberFormat(tag, options)
        formats.set(key, format)
    }
    return format
}

/**
 * A size as "12.4 kB", "1.2 MB" or "123 MB", for every size the editor shows:
 * decimal units (1 MB = 1,000,000 bytes) in the UI locale, with at most one decimal below 100
 * of a unit and none from 100. A small file is "0.2 kB".
 */
export const formatSize = (bytes: number, locale: string = currentLocale()) => {
    const [unit, scale] =
        bytes >= 1e9 ? ['gigabyte', 1e9] : bytes >= 1e6 ? ['megabyte', 1e6] : ['kilobyte', 1e3]
    const value = Math.max(bytes / scale, bytes ? 0.1 : 0)
    return (
        numberFormat(locale, {
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
    numberFormat(locale).format(count)

/** A decimal such as a speed in the UI locale: "0,5" in French, at most three fractions. */
export const formatDecimal = (value: number, locale: string = currentLocale()) =>
    numberFormat(locale, { maximumFractionDigits: 3 }).format(value)

/** A figure with exactly one decimal in the UI locale: "4.5", "4,5". */
export const formatTenths = (value: number, locale: string = currentLocale()) =>
    numberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)

// Seconds as "9.7s", or "9,7 s" and "9.7 秒" where the narrow unit reads poorly; spelled out for
// screen readers.
const seconds = (locale: string, long: boolean, digits: number) =>
    numberFormat(locale, {
        style: 'unit',
        unit: 'second',
        unitDisplay: long ? 'long' : locale === 'fr' || locale === 'ja' ? 'short' : 'narrow',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    })

/** Whole seconds: "10s", "10 s", "10 秒". */
export const formatWholeSeconds = (value: number, locale: string = currentLocale()) =>
    seconds(locale, false, 0).format(value)

/**
 * A duration in seconds with one decimal; under 0.1 s with two, rounded up, so a time that is
 * there never reads as none. Exactly none is "0s".
 */
export const formatSeconds = (value: number, locale: string = currentLocale(), long = false) => {
    if (value <= 0) return seconds(locale, long, 0).format(0)
    if (value >= 0.1) return seconds(locale, long, 1).format(value)
    const hundredths = Math.max(1, Math.ceil(value * 100 - 1e-9))
    return seconds(locale, long, 2).format(hundredths / 100)
}
