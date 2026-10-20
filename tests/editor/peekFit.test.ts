// Literal numbers measured in the browser (the peek strip fit per language and pane width).
import assert from 'node:assert/strict'
import test from 'node:test'
import { peekLayout, peekText, type PeekWidths } from '../../src/editor/history/peekFit'

const enWidths: PeekWidths = {
    today: 76.796875,
    earlier: 129.0625,
    compact: 121.734375,
    back: 77.984375,
    restore: 46.375,
    labels: 79.3125,
    states: 105.578125,
    statesWide: 108.546875,
    rem: 16,
}
const enLayouts: Record<number, ReturnType<typeof peekLayout>> = {
    170: {
        width: 154,
        back: 'icon',
        tiny: true,
        snug: true,
        wide: false,
        inset: 'pt-7',
        restoreFits: false,
        compact: true,
        narrowArrows: true,
    },
    180: {
        width: 164,
        back: 'icon',
        tiny: true,
        snug: true,
        wide: false,
        inset: 'pt-7',
        restoreFits: false,
        compact: true,
        narrowArrows: false,
    },
    190: {
        width: 167,
        back: 'icon',
        tiny: true,
        snug: true,
        wide: false,
        inset: 'pt-7',
        restoreFits: true,
        compact: true,
        narrowArrows: false,
    },
    200: {
        width: 167,
        back: 'icon',
        tiny: true,
        snug: true,
        wide: false,
        inset: 'pt-7',
        restoreFits: true,
        compact: true,
        narrowArrows: false,
    },
    240: {
        width: 167,
        back: 'icon',
        tiny: true,
        snug: true,
        wide: false,
        inset: 'pt-7',
        restoreFits: true,
        compact: true,
        narrowArrows: false,
    },
    300: {
        width: 167,
        back: 'icon',
        tiny: true,
        snug: true,
        wide: false,
        inset: 'pt-7',
        restoreFits: true,
        compact: true,
        narrowArrows: false,
    },
    320: {
        width: 297,
        back: 'icon',
        tiny: false,
        snug: true,
        wide: false,
        inset: 'pt-7',
        restoreFits: true,
        compact: false,
        narrowArrows: false,
    },
    340: {
        width: 305,
        back: 'icon',
        tiny: false,
        snug: false,
        wide: false,
        inset: 'pt-7',
        restoreFits: true,
        compact: false,
        narrowArrows: false,
    },
    390: {
        width: 305,
        back: 'icon',
        tiny: false,
        snug: false,
        wide: false,
        inset: 'pt-7',
        restoreFits: true,
        compact: false,
        narrowArrows: false,
    },
    548: {
        width: 386,
        back: 'label',
        tiny: false,
        snug: false,
        wide: true,
        inset: 'pt-2',
        restoreFits: true,
        compact: false,
        narrowArrows: false,
    },
    728: {
        width: 386,
        back: 'label',
        tiny: false,
        snug: false,
        wide: true,
        inset: 'pt-2',
        restoreFits: true,
        compact: false,
        narrowArrows: false,
    },
    768: {
        width: 386,
        back: 'label',
        tiny: false,
        snug: false,
        wide: true,
        inset: 'pt-2',
        restoreFits: true,
        compact: false,
        narrowArrows: false,
    },
    904: {
        width: 386,
        back: 'label',
        tiny: false,
        snug: false,
        wide: true,
        inset: 'pt-2',
        restoreFits: true,
        compact: false,
        narrowArrows: false,
    },
    1144: {
        width: 386,
        back: 'label',
        tiny: false,
        snug: false,
        wide: true,
        inset: 'pt-2',
        restoreFits: true,
        compact: false,
        narrowArrows: false,
    },
}

const frWidths: PeekWidths = {
    today: 51.359375,
    earlier: 107.140625,
    compact: 93.25,
    back: 131.625,
    restore: 58.078125,
    labels: 79.3125,
    states: 121.578125,
    statesWide: 170.65625,
    rem: 16,
}
const frLayouts: Record<number, ReturnType<typeof peekLayout>> = {
    170: {
        width: 154,
        back: 'icon',
        tiny: true,
        snug: true,
        wide: false,
        inset: 'pt-7',
        restoreFits: false,
        compact: true,
        narrowArrows: true,
    },
    180: {
        width: 164,
        back: 'icon',
        tiny: true,
        snug: true,
        wide: false,
        inset: 'pt-7',
        restoreFits: false,
        compact: true,
        narrowArrows: false,
    },
    190: {
        width: 174,
        back: 'icon',
        tiny: true,
        snug: true,
        wide: false,
        inset: 'pt-7',
        restoreFits: false,
        compact: true,
        narrowArrows: false,
    },
    200: {
        width: 179,
        back: 'icon',
        tiny: true,
        snug: true,
        wide: false,
        inset: 'pt-7',
        restoreFits: true,
        compact: true,
        narrowArrows: false,
    },
    240: {
        width: 179,
        back: 'icon',
        tiny: true,
        snug: true,
        wide: false,
        inset: 'pt-7',
        restoreFits: true,
        compact: true,
        narrowArrows: false,
    },
    300: {
        width: 280,
        back: 'icon',
        tiny: false,
        snug: true,
        wide: false,
        inset: 'pt-7',
        restoreFits: true,
        compact: true,
        narrowArrows: false,
    },
    320: {
        width: 302,
        back: 'icon',
        tiny: false,
        snug: true,
        wide: false,
        inset: 'pt-7',
        restoreFits: true,
        compact: false,
        narrowArrows: false,
    },
    340: {
        width: 302,
        back: 'icon',
        tiny: false,
        snug: false,
        wide: false,
        inset: 'pt-7',
        restoreFits: true,
        compact: false,
        narrowArrows: false,
    },
    390: {
        width: 302,
        back: 'icon',
        tiny: false,
        snug: false,
        wide: false,
        inset: 'pt-7',
        restoreFits: true,
        compact: false,
        narrowArrows: false,
    },
    548: {
        width: 429,
        back: 'label',
        tiny: false,
        snug: false,
        wide: true,
        inset: 'pt-7',
        restoreFits: true,
        compact: false,
        narrowArrows: false,
    },
    728: {
        width: 429,
        back: 'label',
        tiny: false,
        snug: false,
        wide: true,
        inset: 'pt-2',
        restoreFits: true,
        compact: false,
        narrowArrows: false,
    },
    768: {
        width: 429,
        back: 'label',
        tiny: false,
        snug: false,
        wide: true,
        inset: 'pt-2',
        restoreFits: true,
        compact: false,
        narrowArrows: false,
    },
    904: {
        width: 429,
        back: 'label',
        tiny: false,
        snug: false,
        wide: true,
        inset: 'pt-2',
        restoreFits: true,
        compact: false,
        narrowArrows: false,
    },
    1144: {
        width: 429,
        back: 'label',
        tiny: false,
        snug: false,
        wide: true,
        inset: 'pt-2',
        restoreFits: true,
        compact: false,
        narrowArrows: false,
    },
}

test('peekLayout gives the measured layouts in English and French', () => {
    for (const [widths, layouts] of [
        [enWidths, enLayouts],
        [frWidths, frLayouts],
    ] as const)
        for (const [pane, expected] of Object.entries(layouts))
            assert.deepEqual(peekLayout(Number(pane), widths), expected, pane)
})

test('the date shows whole or as its glyph, never cut (English 300 to 312 px panes take the glyph)', () => {
    assert.equal(peekLayout(312, enWidths).tiny, true)
    assert.equal(peekLayout(313, enWidths).tiny, false)
    assert.equal(peekLayout(299, frWidths).tiny, true)
    assert.equal(peekLayout(300, frWidths).tiny, false)
})

test('a 20 px root scales every width by 1.25', () => {
    const scaled = Object.fromEntries(
        Object.entries(enWidths).map(([k, v]) => [k, v * 1.25]),
    ) as PeekWidths
    for (const pane of [1144, 904, 548]) {
        const at20 = peekLayout(pane, scaled).width
        assert.ok(Math.abs(at20 - enLayouts[pane]!.width * 1.25) <= 1, String(pane))
    }
})

test('peekText: today, earlier this year, another year', () => {
    const now = new Date(2026, 9, 19, 12, 0, 0).getTime()
    // The clock and dates as Intl writes them (a narrow no-break space may precede AM and PM).
    const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ')
    assert.equal(
        plain(peekText('en', new Date(2026, 9, 19, 9, 5, 7).getTime(), true, now)),
        '9:05:07 AM',
    )
    assert.match(
        plain(peekText('en', new Date(2026, 2, 3, 21, 5, 7).getTime(), true, now)),
        /^Mar 3, 9:05:07 PM$/,
    )
    assert.equal(
        plain(peekText('en', new Date(2026, 2, 3, 21, 5, 7).getTime(), false, now)),
        '3/3/26, 9:05 PM',
    )
    assert.equal(
        plain(peekText('en', new Date(2025, 2, 3, 21, 5, 7).getTime(), true, now)),
        '3/3/25, 9:05 PM',
    )
})

// Japanese tiny strips are 148 px: 48 px arrows would overflow their capsule by 8 px.
const jaWidths: PeekWidths = {
    today: 51.359375,
    earlier: 113.375,
    compact: 93.25,
    back: 70,
    restore: 28,
    labels: 79.3125,
    states: 83.40625,
    statesWide: 119.40625,
    rem: 16,
}

test('the capsule takes the options button and narrow arrows by fit', () => {
    assert.equal(peekLayout(240, jaWidths).width, 148)
    // 238 px from the strip's 250 would cut 取得できません (83 px in 70): the strip widens to 264.
    assert.equal(peekLayout(320, jaWidths).width, 264)
    assert.equal(peekLayout(240, jaWidths).narrowArrows, true)
    assert.equal(peekLayout(300, jaWidths).narrowArrows, false)
    assert.equal(peekLayout(320, jaWidths).compact, false)
    assert.equal(peekLayout(319, jaWidths).compact, true)
    // A 20 px root on a 390 px phone: the tiny strip leaves no room for the eye and the summary.
    const scaled = Object.fromEntries(
        Object.entries(enWidths).map(([k, v]) => [k, v * 1.25]),
    ) as PeekWidths
    assert.equal(peekLayout(390, scaled).tiny, true)
    assert.equal(peekLayout(390, scaled).compact, true)
})

// Every language's widths at the 16 px root, as measured. states and statesWide: the widest fixed
// line at 12 px (changes.ts fixedLines), the passive ones short under 480 px panes and long from 480,
// and "Settings changed" in the summary button plus its 14 px (English, French, Turkish and Chinese
// take that one: 91.58, 107.58, 95.42 and 60 px of text).
const allWidths: Record<string, PeekWidths> = {
    en: enWidths,
    fr: frWidths,
    ja: jaWidths,
    ko: {
        today: 83.1875,
        earlier: 149.046875,
        compact: 130.953125,
        back: 101.84375,
        restore: 28,
        labels: 79.3125,
        states: 78.578125,
        statesWide: 145.15625,
        rem: 16,
    },
    tr: {
        today: 51.359375,
        earlier: 100.59375,
        compact: 88.421875,
        back: 78.328125,
        restore: 61.390625,
        labels: 79.3125,
        states: 109.421875,
        statesWide: 140.625,
        rem: 16,
    },
    zhs: {
        today: 51.359375,
        earlier: 113.375,
        compact: 93.25,
        back: 56,
        restore: 28,
        labels: 79.3125,
        states: 74,
        statesWide: 80.796875,
        rem: 16,
    },
    zht: {
        today: 79.359375,
        earlier: 141.375,
        compact: 121.25,
        back: 56,
        restore: 28,
        labels: 79.3125,
        states: 74,
        statesWide: 80.796875,
        rem: 16,
    },
}

// The strip and capsule widths as the browser drew them (16 px root), and the capsule's room for the
// state line: the capsule less p-1, the eye, the gaps, px-2 and both arrows (168 px).
const capsules: Record<string, Record<number, number>> = {
    en: { 390: 305, 375: 305, 320: 297, 1144: 386 },
    fr: { 390: 302, 375: 302, 320: 302, 1144: 429 },
    ja: { 390: 324, 375: 324, 320: 264, 1144: 344 },
    ko: { 390: 295, 375: 295, 320: 287, 1144: 411 },
    tr: { 390: 361, 375: 290, 320: 290, 1144: 373 },
    zhs: { 390: 310, 375: 310, 320: 302, 1144: 330 },
    zht: { 390: 338, 375: 338, 320: 278, 1144: 358 },
}

test('every state line fits its capsule from 320 px panes, in every language', () => {
    for (const [locale, widths] of Object.entries(allWidths))
        for (const [pane, width] of Object.entries(capsules[locale]!)) {
            const layout = peekLayout(Number(pane), widths)
            const line = layout.wide ? widths.statesWide : widths.states
            assert.equal(layout.width, width, `${locale} ${pane}`)
            assert.equal(layout.compact, false, `${locale} ${pane}`)
            assert.equal(layout.narrowArrows, false, `${locale} ${pane}`)
            assert.ok(layout.width - 12 - 168 >= line, `${locale} ${pane}`)
        }
    // Under 320 px panes the options button holds the line, as before.
    for (const [locale, widths] of Object.entries(allWidths))
        for (const pane of [319, 300, 240])
            assert.equal(peekLayout(pane, widths).compact, true, locale)
})

test('at a 20 px root the state line fits or the options button holds it', () => {
    // Real 20 px measurements are these × 1.25 (French "Paramètres modifiés": 134.48 px). French on
    // the 390 px phone cannot hold it beside the eye and arrows: the options button.
    const at20 = (widths: PeekWidths) =>
        Object.fromEntries(Object.entries(widths).map(([k, v]) => [k, v * 1.25])) as PeekWidths
    const expected: Record<string, Record<number, [number, boolean]>> = {
        en: { 390: [218, true], 375: [218, true], 320: [208, true] },
        fr: { 390: [360, true], 375: [233, true], 320: [223, true] },
        ja: { 390: [330, false], 375: [330, false], 320: [185, true] },
        ko: { 390: [369, false], 375: [195, true], 320: [185, true] },
        tr: { 390: [362, false], 375: [237, true], 320: [227, true] },
        zhs: { 390: [322, false], 375: [322, false], 320: [185, true] },
        zht: { 390: [357, false], 375: [195, true], 320: [185, true] },
    }
    for (const [locale, widths] of Object.entries(allWidths))
        for (const [pane, [width, compact]] of Object.entries(expected[locale]!)) {
            const scaled = at20(widths)
            const layout = peekLayout(Number(pane), scaled)
            assert.equal(layout.width, width, `${locale} ${pane}`)
            assert.equal(layout.compact, compact, `${locale} ${pane}`)
            // A tiny strip keeps its size; its capsule takes the options button.
            if (layout.tiny) assert.equal(layout.compact, true, `${locale} ${pane}`)
            if (!compact)
                assert.ok(layout.width - 1.25 * (12 + 168) >= scaled.states, `${locale} ${pane}`)
        }
})
