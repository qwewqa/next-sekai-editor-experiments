import assert from 'node:assert/strict'
import test from 'node:test'
import { chartCategoryColors } from '../../src/editor/statistics/marks'
import { drawCard, type CardInput } from '../../src/editor/statistics/shareCard'
import { statisticsStringsOf } from '../../src/editor/statistics/strings'
import en from '../../src/i18n/en/index.json'
import {
    CATEGORIES,
    mergeTimes,
    npsFigures,
    npsSets,
    ROWS,
    type Category,
    type ChartStatistics,
    type NpsFigures,
} from '../../src/levelData/statistics'

// The share card's layout, drawn on a recording 2D context: what it writes and where, for the
// branches a card can take.

type Call = { name: string; args: unknown[]; fillStyle: unknown; font: string; textAlign: string }

// Node has no Path2D; the card's paths are drawing.ts's, tested there.
globalThis.Path2D ??= class {} as unknown as typeof Path2D

/**
 * A 2D context that records its calls; text is 0.55 of its size wide per character, and
 * `bearing` gives the right edge of its ink from the end of its advance where a test needs one.
 */
const recorder = ({
    roundRect = true,
    bearing,
}: { roundRect?: boolean; bearing?: (text: string) => number } = {}) => {
    const calls: Call[] = []
    const state = { fillStyle: '' as unknown, font: '10px sans', textAlign: 'start' }
    const record =
        (name: string) =>
        (...args: unknown[]) => {
            calls.push({ name, args, ...state })
        }
    const context: Record<string, unknown> = {
        get fillStyle() {
            return state.fillStyle
        },
        set fillStyle(value: unknown) {
            state.fillStyle = value
        },
        get font() {
            return state.font
        },
        set font(value: string) {
            state.font = value
        },
        get textAlign() {
            return state.textAlign
        },
        set textAlign(value: string) {
            state.textAlign = value
        },
        measureText: (text: string) => {
            const size = Number(/(\d+(\.\d+)?)px/.exec(state.font)?.[1] ?? 10)
            const width = [...text].length * size * 0.55
            // Measured from the alignment point, as a browser does.
            const right = bearing && bearing(text) + (state.textAlign === 'right' ? 0 : width)
            return { width, actualBoundingBoxRight: right }
        },
    }
    for (const name of [
        'setTransform',
        'fillRect',
        'fillText',
        'beginPath',
        'moveTo',
        'lineTo',
        'arcTo',
        'closePath',
        'fill',
        'stroke',
        'save',
        'restore',
        'clip',
        'drawImage',
        'translate',
    ])
        context[name] = record(name)
    if (roundRect) context.roundRect = record('roundRect')
    const canvas = { width: 0, height: 0, getContext: () => context }
    return { canvas: canvas as unknown as HTMLCanvasElement, calls }
}

const times = (list: number[]) => Float64Array.from(list).sort()
const statsOf = (byCategory: Partial<Record<Category, number[]>>): ChartStatistics => {
    const all = Object.fromEntries(
        CATEGORIES.map((category) => [category, times(byCategory[category] ?? [])]),
    ) as Record<Category, Float64Array>
    const counts = Object.fromEntries(ROWS.map((row) => [row, 0])) as ChartStatistics['counts']
    counts.tap = all.tap.length
    counts.flick = all.flick.length
    counts.release = all.release.length
    counts.trace = all.trace.length
    counts.tick = all.tick.length
    counts.damageNote = all.damage.length
    return {
        counts,
        critical: {},
        combo: Object.values(counts).reduce((a, b) => a + b, 0),
        times: all,
    }
}

const stats = statsOf({
    tap: [0.5, 1, 1.5, 2, 2.2, 8],
    flick: [1.25, 3],
    release: [2.5],
    trace: [4, 4.5],
    tick: [5, 5.5],
    damage: [6],
})

const input = (overrides: Partial<CardInput> = {}): CardInput => ({
    info: { title: 'Level', artists: 'Artist', author: 'Author Name', rating: 29 },
    link: '',
    stats,
    every: mergeTimes(CATEGORIES.map((category) => stats.times[category])).times,
    figures: undefined,
    drawable: true,
    chosen: ['tap', 'flick', 'release'],
    mode: 'smooth',
    glyphs: {},
    theme: {
        modal: [233, 235, 239],
        header: [188, 188, 209],
        fg: [68, 68, 102],
        recess: 'rgb(68 68 102 / 0.1)',
        dark: false,
    },
    fontFamily: 'sans-serif',
    locale: 'en',
    strings: {
        ...statisticsStringsOf(en),
        rows: Object.fromEntries(
            ROWS.map((row) => [row, `Row ${row}`]),
        ) as CardInput['strings']['rows'],
        categories: Object.fromEntries(
            CATEGORIES.map((category) => [category, `Key ${category}`]),
        ) as CardInput['strings']['categories'],
        untitled: 'Untitled',
        author: 'Author',
        rating: 'Rating',
        product: 'Next SEKAI Editor',
    },
    ...overrides,
})

const draw = (
    overrides: Partial<CardInput> = {},
    options?: { roundRect?: boolean; bearing?: (text: string) => number },
) => {
    const { canvas, calls } = recorder(options)
    drawCard(canvas, input(overrides))
    assert.equal(canvas.width, 1600)
    assert.equal(canvas.height, 900)
    return calls
}
/** The calls that draw a path object: the chart's, not the card's own shapes. */
const paths = (calls: Call[], name: 'fill' | 'stroke') =>
    calls.filter((call) => call.name === name && call.args[0] instanceof Path2D)
const texts = (calls: Call[]) =>
    calls.filter((call) => call.name === 'fillText').map((call) => call.args[0] as string)
const fills = (calls: Call[], color: string) =>
    calls.filter(
        (call) => (call.name === 'fill' || call.name === 'fillRect') && call.fillStyle === color,
    )

test('the key lists the chosen categories with notes, from the baseline up, and the list is full', () => {
    const calls = draw({ chosen: ['tap', 'flick', 'release', 'traceFlick'] })
    const keys = calls.filter(
        (call) => call.name === 'fillText' && String(call.args[0]).startsWith('Key '),
    )
    // Trace Flick has no notes, so it is in neither the key nor the chart.
    assert.deepEqual(
        keys.map((call) => call.args[0]),
        ['Key tap', 'Key flick', 'Key release'],
    )
    const ys = keys.map((call) => call.args[2] as number)
    assert.ok(ys[0]! > ys[1]! && ys[1]! > ys[2]!)
    // The list has every row with notes, whatever the chart counts.
    for (const row of ['tap', 'flick', 'release', 'trace', 'tick', 'damageNote'])
        assert.ok(texts(calls).includes(`Row ${row}`), row)
    assert.ok(!texts(calls).includes('Row fakeNote'))
    for (const category of ['tap', 'flick', 'release'] as const)
        assert.ok(fills(calls, chartCategoryColors[category]).length > 0, category)
    assert.equal(fills(calls, chartCategoryColors.trace).length, 0)
    // Smooth fills one area per chosen layer, from the dialog's own paths.
    assert.deepEqual(
        paths(calls, 'fill').map((call) => call.fillStyle),
        ['tap', 'flick', 'release', 'traceFlick'].map(
            (category) => chartCategoryColors[category as Category],
        ),
    )
})

test('with nothing chosen the chart says so, and draws no layer', () => {
    const calls = draw({ chosen: [] })
    assert.ok(texts(calls).includes('No notes to count'))
    for (const category of CATEGORIES)
        assert.equal(fills(calls, chartCategoryColors[category]).length, 0, category)
})

test('Bars draws tiles in the layer colours, and Rolling draws ink with no swatches', () => {
    const bars = draw({ mode: 'bars', chosen: [...CATEGORIES] })
    const tiles = bars.filter((call) => call.name === 'fillRect' && call.fillStyle !== '')
    assert.ok(
        tiles.some((call) => call.fillStyle === chartCategoryColors.damage),
        'a damage tile',
    )
    const rolling = draw({ mode: 'rolling', chosen: [...CATEGORIES] })
    for (const category of CATEGORIES)
        assert.equal(fills(rolling, chartCategoryColors[category]).length, 0, category)
    assert.ok(texts(rolling).includes('Key tap'))
    // Rolling fills its wash and strokes its line.
    assert.equal(paths(rolling, 'fill').length, 1)
    assert.equal(paths(rolling, 'stroke').length, 1)
})

test('a long title takes two lines and an ellipsis; empty fields leave their lines out', () => {
    const long = draw({ info: { title: 'Word '.repeat(60), artists: '', author: '' } })
    const lines = long.filter(
        (call) => call.name === 'fillText' && call.font.startsWith('700 26px'),
    )
    assert.equal(lines.length, 2)
    assert.ok(String(lines[1]!.args[0]).endsWith('…'))
    assert.ok(!texts(long).includes('Author'))
    assert.ok(!texts(long).includes('Rating'))
    const untitled = draw({ info: { title: '  ', artists: ' ', author: '' } })
    assert.ok(texts(untitled).includes('Untitled'))
})

test('without Intl.Segmenter the card still wraps and cuts', () => {
    const segmenter = Intl.Segmenter
    // @ts-expect-error: the browsers before it
    delete Intl.Segmenter
    try {
        const calls = draw({
            info: { title: '例のとても長いタイトル'.repeat(12), artists: 'A', author: '' },
        })
        const lines = calls.filter(
            (call) => call.name === 'fillText' && call.font.startsWith('700 26px'),
        )
        assert.equal(lines.length, 2)
        assert.ok(String(lines[1]!.args[0]).endsWith('…'))
        // Latin text breaks between words.
        const latin = draw({ info: { title: 'Alpha Beta '.repeat(20), artists: '', author: '' } })
        const [first] = latin.filter(
            (call) => call.name === 'fillText' && call.font.startsWith('700 26px'),
        )
        assert.match(String(first!.args[0]), /^(Alpha|Beta)( (Alpha|Beta))*$/)
    } finally {
        Object.assign(Intl, { Segmenter: segmenter })
    }
})

test('without roundRect the cover and swatches take arcs', () => {
    const image = { width: 400, height: 400 } as unknown as CardInput['cover']
    const calls = draw({ cover: image }, { roundRect: false })
    assert.ok(calls.some((call) => call.name === 'arcTo'))
    assert.ok(!calls.some((call) => call.name === 'roundRect'))
})

test('a cover that is not square is fitted and centred in its tile', () => {
    for (const [width, height, expected] of [
        [1920, 1080, [16, 16 + (88 - 49.5) / 2, 88, 49.5]],
        [100, 200, [16 + 22, 16, 44, 88]],
        [300, 300, [16, 16, 88, 88]],
    ] as const) {
        const cover = { width, height } as unknown as CardInput['cover']
        const calls = draw({ cover })
        const drawn = calls.find((call) => call.name === 'drawImage' && call.args[0] === cover)
        assert.ok(drawn)
        assert.deepEqual(
            drawn.args.slice(1).map((value) => Math.round((value as number) * 100) / 100),
            expected,
        )
    }
    // No cover: the text starts at the band's edge.
    const plain = draw()
    const title = plain.find((call) => call.name === 'fillText' && call.args[0] === 'Level')
    assert.equal(title?.args[1], 16)
})

test('the plot lies on whole pixels of the 2x canvas in every band layout', () => {
    for (const info of [
        { title: 'One', artists: '', author: '', rating: 5 },
        { title: 'Word '.repeat(30), artists: 'A', author: 'B', rating: 12 },
        { title: 'One', artists: '', author: '' },
    ]) {
        const calls = draw({ info, mode: 'bars', chosen: [...CATEGORIES] })
        const origin = calls.find((call) => call.name === 'translate')
        assert.ok(origin)
        for (const value of origin.args as number[])
            assert.equal(Math.round(value * 2), value * 2, `${info.title}: ${value}`)
    }
})

// --- Average and Median on the heading's line.

const figuresOf = (chosen: readonly Category[]) => {
    const sets = npsSets(stats.times, chosen)
    return sets && npsFigures(sets)
}
const mixed: Category[] = ['tap', 'flick', 'release', 'trace']
const textCall = (calls: Call[], text: string) =>
    calls.find((call) => call.name === 'fillText' && call.args[0] === text)
const xOf = (call: Call | undefined) => call?.args[1] as number
const widthOf = (text: string, size: number) => [...text].length * size * 0.55
/** The four figure texts, right to left: Median's value and label, then Average's. */
const figureCalls = (calls: Call[]) => {
    const y = textCall(calls, 'Notes per Second')?.args[2]
    return calls.filter(
        (call) => call.name === 'fillText' && call.textAlign === 'right' && call.args[2] === y,
    )
}

test('Average and Median end at the right edge of the footer, on the heading line', () => {
    const figures = figuresOf(mixed)
    assert.ok(figures?.hasPrimary && figures.hasSecondary)
    const calls = draw({ chosen: mixed, figures })
    const heading = textCall(calls, 'Notes per Second')
    assert.ok(heading)
    const average = `${figures.primary.average.toFixed(1)} (${figures.all.average.toFixed(1)})`
    const median = `${figures.primary.median} (${figures.all.median})`
    const [medianValue, medianLabel, averageValue, averageLabel] = figureCalls(calls)
    assert.deepEqual(
        [medianValue, medianLabel, averageValue, averageLabel].map((call) => call?.args[0]),
        [median, 'Median', average, 'Average'],
    )
    for (const call of [medianValue, medianLabel, averageValue, averageLabel])
        assert.equal(call?.args[2], heading.args[2])
    assert.equal(xOf(medianValue), 784)
    assert.equal(xOf(medianLabel), 784 - widthOf(median, 15) - 6)
    assert.equal(xOf(averageValue), xOf(medianLabel) - widthOf('Median', 13.5) - 20)
    assert.equal(xOf(averageLabel), xOf(averageValue) - widthOf(average, 15) - 6)
    assert.equal(averageValue?.font, '400 15px sans-serif')
    assert.equal(averageLabel?.font, '400 13.5px sans-serif')
})

test('each figure value has its trailing bearing trimmed, so the group and its gap run by ink', () => {
    const figures = figuresOf(mixed)
    const xs = (calls: Call[]) => figureCalls(calls).map(xOf)
    const plain = xs(draw({ chosen: mixed, figures }))
    const trimmed = xs(
        draw({ chosen: mixed, figures }, { bearing: (text) => (/\d/.test(text) ? -4 : 0) }),
    )
    // The group moves 4 right, and the gap between the figures narrows by 4.
    assert.deepEqual(trimmed, [plain[0]! + 4, plain[1]! + 4, plain[2]! + 8, plain[3]! + 8])
})

test('no figures are drawn without notes or when the chart is not drawable', () => {
    for (const overrides of [
        { chosen: [], figures: undefined },
        { chosen: mixed, figures: figuresOf(mixed), drawable: false },
    ]) {
        const calls = draw(overrides)
        assert.ok(textCall(calls, 'Notes per Second'))
        assert.ok(!texts(calls).includes('Average'))
        assert.ok(!texts(calls).includes('Median'))
    }
})

test('the heading is cut to the width the figures leave, and the figures never are', () => {
    const many = { average: 10000, median: 10000, p90: 10000, p99: 10000 }
    const huge: NpsFigures = { all: many, primary: many, hasPrimary: true, hasSecondary: true }
    for (const [notesPerSecond, figures] of [
        ['Notes per Second in a Very Long Language', figuresOf(mixed)],
        ['Notes per Second', huge],
    ] as const) {
        const calls = draw({
            chosen: mixed,
            figures,
            strings: { ...input().strings, notesPerSecond },
        })
        // The heading is the last bold 15 text, after the author's label.
        const heading = calls
            .filter((call) => call.name === 'fillText' && call.font === '700 15px sans-serif')
            .at(-1)
        assert.ok(heading)
        const text = String(heading.args[0])
        assert.ok(text.endsWith('…'), text)
        const left = xOf(textCall(calls, 'Average')) - widthOf('Average', 13.5)
        assert.ok(xOf(heading) + widthOf(text, 15) <= left - 16)
    }
    const calls = draw({ chosen: mixed, figures: huge })
    assert.ok(texts(calls).includes('10,000.0 (10,000.0)'))
    assert.ok(texts(calls).includes('10,000 (10,000)'))
})

test('the figures take no plot height', () => {
    const plot = (figures: NpsFigures | undefined) => {
        const calls = draw({ chosen: mixed, figures })
        return [
            calls.find((call) => call.name === 'translate')?.args,
            calls
                .filter(
                    (call) => call.name === 'fillText' && String(call.args[0]).startsWith('Key '),
                )
                .map((call) => call.args[2]),
        ]
    }
    assert.deepEqual(plot(figuresOf(mixed)), plot(undefined))
})
