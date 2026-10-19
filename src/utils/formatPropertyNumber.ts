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
    const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
    const digit = Array.from({ length: 10 }, (_, n) => formatter.format(n))
    const decimal =
        new Intl.NumberFormat(locale).formatToParts(1.1).find(({ type }) => type === 'decimal')
            ?.value ?? '.'
    const prefix = negative
        ? formatter
              .formatToParts(-1)
              .slice(0, -1)
              .map(({ value }) => value)
              .join('')
        : ''
    return (
        prefix +
        formatter.format(BigInt(whole)) +
        (fraction ? decimal + fraction.replace(/\d/g, (n) => digit[Number(n)] ?? n) : '')
    )
}
