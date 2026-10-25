import assert from 'node:assert/strict'
import test from 'node:test'
import { formatPropertyNumber } from '../../src/utils/formatPropertyNumber'

// formatPropertyNumber keeps each locale's formatter. The text must stay identical to the text from
// a new formatter made for each call.

const uncached = (value: number, locale: string, decimalShift = 0) => {
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

test('cached locale formatting gives the text a fresh formatter gives', () => {
    const locales = ['en', 'fr', 'ja', 'ko', 'tr', 'zh-Hans', 'zh-Hant', 'ar-EG', 'de-CH', 'hi-IN']
    const values = [0, -0, 1, -1, 0.5, -0.0000001, 1e21, 123456789.125, -2.5e-7, 1234.5678]
    let seed = 7
    for (let i = 0; i < 200; i++) {
        seed = (seed * 48271) % 2147483647
        values.push((seed / 2147483647 - 0.5) * 10 ** ((seed % 14) - 4))
    }
    for (const locale of locales)
        for (const value of values)
            for (const shift of [0, 3, -2])
                assert.equal(
                    formatPropertyNumber(value, locale, shift),
                    uncached(value, locale, shift),
                    `${locale} ${value} ${shift}`,
                )
})
