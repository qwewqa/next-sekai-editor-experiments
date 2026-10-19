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
        width: 280,
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
        width: 288,
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
        width: 288,
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
    rem: 16,
}

test('the capsule takes the options button and narrow arrows by fit', () => {
    assert.equal(peekLayout(240, jaWidths).width, 148)
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
