/** The formatter, digits, decimal sign and minus prefix of a locale, made once and reused. */
const parts = new Map<
    string,
    { formatter: Intl.NumberFormat; digit: string[]; decimal: string; minus: string }
>()
const localeParts = (locale: string) => {
    let known = parts.get(locale)
    if (!known) {
        const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
        known = {
            formatter,
            digit: Array.from({ length: 10 }, (_, n) => formatter.format(n)),
            decimal:
                new Intl.NumberFormat(locale)
                    .formatToParts(1.1)
                    .find(({ type }) => type === 'decimal')?.value ?? '.',
            minus: formatter
                .formatToParts(-1)
                .slice(0, -1)
                .map(({ value }) => value)
                .join(''),
        }
        parts.set(locale, known)
    }
    return known
}

/** Exact decimal shifting avoids rounding seconds before displaying milliseconds. */
export const formatPropertyNumber = (value: number, locale: string, decimalShift = 0) => {
    if (!Number.isFinite(value)) throw new TypeError('A property number must be finite')
    const negative = value < 0
    const [coefficient = '', exponent = '0'] = String(Math.abs(value)).split('e')
    const dot = coefficient.indexOf('.')
    const digits = coefficient.replace('.', '')
    const split = (dot < 0 ? coefficient.length : dot) + Number(exponent) + decimalShift
    const whole = split <= 0 ? '0' : digits.slice(0, split).padEnd(split, '0')
    const fraction = split <= 0 ? '0'.repeat(-split) + digits : digits.slice(split)
    const { formatter, digit, decimal, minus } = localeParts(locale)
    const prefix = negative ? minus : ''
    return (
        prefix +
        formatter.format(BigInt(whole)) +
        (fraction ? decimal + fraction.replace(/\d/g, (n) => digit[Number(n)] ?? n) : '')
    )
}
