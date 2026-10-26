import { pluralForm } from '../i18n/plural'
import { formatCount } from './size'

// Set by i18n, so this module stays off the settings import cycle.
let currentLocale = () => 'en'

/** Names the locale whose plural rules messages follow. */
export const setInterpolationLocale = (locale: () => string) => {
    currentLocale = locale
}

// Messages with singular and plural forms agree with their first value. A number is a count: it
// picks the form as it is and shows in the locale's digits and grouping.
// One pass, so values go in verbatim, even with "$&" or "{1}" in them.
const fill = (message: string, params: (string | number)[]) =>
    pluralForm(currentLocale(), message, params[0]).replace(
        /\{(\d+)\}/g,
        (placeholder, index: string) => {
            const param = params[Number(index)]
            return typeof param === 'number' ? formatCount(param) : (param ?? placeholder)
        },
    )

export const interpolate =
    (message: () => string, ...params: (string | number | (() => string))[]) =>
    () =>
        fill(
            message(),
            params.map((param) => (typeof param === 'function' ? param() : param)),
        )

export const interpolateRaw = (message: string, ...params: (string | number)[]) =>
    fill(message, params)
