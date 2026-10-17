import type { RecordValue } from '../../../src/local/records/canonical'

// Hand-written vectors (§1.6.11.1): each expected text is typed by hand and reviewed against
// ECMA-262 `Number::toString` and `QuoteJSONString`. They run in Chromium, Firefox and WebKit
// too (`tests/browser/recordVectors.spec.ts`), since engines may differ in a float's last digit.
export const canonicalVectors: [name: string, value: RecordValue, text: string][] = [
    ['1e21', 1e21, '1e+21'],
    ['1e-7', 1e-7, '1e-7'],
    ['0.000001', 0.000001, '0.000001'],
    ['1e20', 1e20, '100000000000000000000'],
    ['-1.5', -1.5, '-1.5'],
    ['-1e-7', -1e-7, '-1e-7'],
    ['5e-324', 5e-324, '5e-324'],
    ['max', 1.7976931348623157e308, '1.7976931348623157e+308'],
    ['2 ** 53', 2 ** 53, '9007199254740992'],
    ['-0', -0, '0'],
    ['0.1 + 0.2', 0.1 + 0.2, '0.30000000000000004'],
    ['1 / 3', 1 / 3, '0.3333333333333333'],
    ['lone low surrogate', '\udc00', '"\\udc00"'],
    ['lone high surrogate', '\ud83d', '"\\ud83d"'],
    ['vertical tab', '\u000b', '"\\u000b"'],
    ['nul', '\u0000', '"\\u0000"'],
    ['unit separator', '\u001f', '"\\u001f"'],
    ['short escapes', '\b\f\n\r\t', '"\\b\\f\\n\\r\\t"'],
    ['quote and backslash', '"\\', '"\\"\\\\"'],
    ['space', ' ', '" "'],
    ['slash', '/', '"/"'],
    ['delete raw', '\u007f', '"\u007f"'],
    ['line separator raw', '\u2028', '"\u2028"'],
    ['paragraph separator raw', '\u2029', '"\u2029"'],
    ['astral raw', '\u{1F600}', '"\u{1F600}"'],
    ['not normalised', ['Caf\u00e9', 'Cafe\u0301'], '["Caf\u00e9","Cafe\u0301"]'],
    ['booleans', [true, false], '[true,false]'],
    ['nested', [1, [2, []], 'a'], '[1,[2,[]],"a"]'],
]
