import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { afterEach, test } from 'node:test'

// The Timeline's day, hour and minute labels depend on the host's time zone. A zone with daylight
// saving time makes the 23-hour and 25-hour days testable. node:test runs each file in its own
// process, so setting the zone here leaves the other files alone.
process.env.TZ = 'America/New_York'
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
assert.equal(
    zone,
    'America/New_York',
    `This platform ignores TZ (the resolved zone is ${zone}); the DST cases cannot run`,
)

// Two modules need a browser: src/i18n/localizations.ts collects the catalogues with Vite's
// import.meta.glob, and src/settings.ts reads media queries and storage. A load hook swaps them for
// the three catalogues read from their JSON files and a settings object with only the locale.
const here = (path: string) => new URL(path, import.meta.url).href
const stubs: Record<string, string> = {
    [here('../../src/i18n/localizations.ts')]: [
        ...['en', 'fr', 'ja'].map(
            (locale) =>
                `import ${locale} from ${JSON.stringify(here(`../../src/i18n/${locale}/index.json`))} with { type: 'json' }`,
        ),
        'export const localizations = { en, fr, ja }',
    ].join('\n'),
    [here('../../src/settings.ts')]: [
        "import { reactive } from 'vue'",
        "export const settings = reactive({ locale: 'en' })",
    ].join('\n'),
}
registerHooks({
    load: (url, context, next) =>
        url in stubs
            ? { format: 'module', shortCircuit: true, source: stubs[url] }
            : next(url, context),
})

const {
    headerText: headerTextOf,
    newerStepsText,
    dayLabel: dayLabelOf,
    pinnedText: pinnedTextOf,
    stepsText,
} = await import('../../src/editor/history/labels')
const { dayKey, resolveZone } = await import('../../src/calendar/calendar')
const { calendarAt } = await import('../../src/editor/history/calendarClock')
const { settings } = await import('../../src/settings')
const { default: en } = await import('../../src/i18n/en/index.json', { with: { type: 'json' } })
const { default: fr } = await import('../../src/i18n/fr/index.json', { with: { type: 'json' } })
const { default: ja } = await import('../../src/i18n/ja/index.json', { with: { type: 'json' } })

type Header = Parameters<typeof headerTextOf>[0]

// The labels take the History calendar; these take the clock's time and read it in New York.
const newYork = resolveZone('America/New_York')
const dayLabel = (time: number, clock: number) =>
    dayLabelOf(dayKey(time, newYork), calendarAt(clock, newYork))
const headerText = (value: Header, clock: number) => headerTextOf(value, calendarAt(clock, newYork))
const pinnedText = (value: Header, clock: number) => pinnedTextOf(value, calendarAt(clock, newYork))

const catalogues = { en, fr, ja } as const
type Locale = keyof typeof catalogues

const at = (year: number, month: number, day: number, hour = 12, minute = 0) =>
    new Date(year, month - 1, day, hour, minute).getTime()

const now = at(2026, 10, 16, 15, 30)

const inLocale = (locale: Locale) => {
    settings.locale = locale
}

const header = (level: Header['level'], time: number, withDay = false): Header => ({
    type: 'header',
    id: `${level}:${time}`,
    level,
    withDay,
    time,
    day: dayKey(time, newYork),
})

afterEach(() => {
    inLocale('en')
})

test('the host zone is the one this file asks for', () => {
    assert.equal(new Date(at(2026, 7, 1, 12)).getTimezoneOffset(), 240)
    assert.equal(new Date(at(2026, 1, 1, 12)).getTimezoneOffset(), 300)
})

test('the first header of a new day says its day, and a today at the top says none', async () => {
    inLocale('en')
    const { buildRows } = await import('../../src/editor/history/rows')
    const clock = at(2026, 10, 16, 18, 30)
    const cal = calendarAt(clock, newYork)
    const textsOf = (...times: number[]) =>
        buildRows(
            times.map(
                (time, i) =>
                    ({
                        sessionId: 's',
                        seq: times.length - i,
                        time,
                        kept: true,
                        kind: 'init',
                    }) as never,
            ),
            { filter: 'all', expanded: new Set(), damaged: new Set(), calendar: cal },
        )
            .filter((row) => row.type === 'header')
            .map((row) => headerTextOf(row, cal))
    // Rows for tomorrow, then today's morning below them, newest first.
    assert.deepEqual(textsOf(at(2026, 10, 17, 15, 5), at(2026, 10, 16, 8, 5)), [
        'Oct 17 · 3 PM',
        'Today · 8 AM',
    ])
    // A today that opens the list names nothing.
    assert.deepEqual(textsOf(at(2026, 10, 16, 18, 10)), ['6:10 PM'])
    assert.deepEqual(textsOf(at(2026, 10, 16, 14, 41)), ['2 PM'])
    // Yesterday at the top names itself.
    assert.deepEqual(textsOf(at(2026, 10, 15, 21, 5)), ['Yesterday · 9 PM'])
})

test("Go To's day label follows the calendar it is given, not the host zone or the real clock", () => {
    inLocale('en')
    // 2026-10-16 02:30 UTC is Oct 15 at 10:30 PM in New York and Oct 16 in Tokyo.
    const instant = Date.UTC(2026, 9, 16, 2, 30)
    const tokyo = resolveZone('Asia/Tokyo')
    assert.equal(dayLabelOf(dayKey(instant, tokyo), calendarAt(instant, tokyo)), en.history.today)
    assert.equal(
        dayLabelOf(dayKey(instant, newYork), calendarAt(instant, newYork)),
        en.history.today,
    )
    // New York's Oct 15, as the calendar moves on: Yesterday a day later, a date after two.
    assert.equal(
        dayLabelOf(dayKey(instant, newYork), calendarAt(instant + 24 * 3_600_000, newYork)),
        en.history.yesterday,
    )
    assert.equal(
        dayLabelOf(dayKey(instant, newYork), calendarAt(instant + 48 * 3_600_000, newYork)),
        'Oct 15',
    )
})

test('a day is Today, Yesterday or its date in each language', () => {
    for (const locale of ['en', 'fr', 'ja'] as const) {
        inLocale(locale)
        const strings = catalogues[locale].history
        assert.equal(dayLabel(at(2026, 10, 16, 0, 0), now), strings.today, locale)
        assert.equal(dayLabel(at(2026, 10, 16, 15, 30), now), strings.today, locale)
        assert.equal(dayLabel(at(2026, 10, 15, 23, 59), now), strings.yesterday, locale)
        assert.equal(dayLabel(at(2026, 10, 15, 0, 0), now), strings.yesterday, locale)
    }
    inLocale('en')
    assert.equal(dayLabel(at(2026, 10, 14), now), 'Oct 14')
    inLocale('fr')
    assert.match(dayLabel(at(2026, 10, 14), now), /^14 oct/)
    inLocale('ja')
    assert.match(dayLabel(at(2026, 10, 14), now), /10月14日/)
})

test('Yesterday is the previous calendar day even when the two are under 24 hours apart', () => {
    inLocale('en')
    // Just after midnight, the previous evening is Yesterday.
    const justAfter = at(2026, 10, 16, 0, 5)
    assert.equal(dayLabel(at(2026, 10, 15, 23, 50), justAfter), en.history.yesterday)
    // A day at least 47 hours back is not.
    assert.equal(dayLabel(at(2026, 10, 14, 0, 5), at(2026, 10, 16, 0, 5)), 'Oct 14')
})

test('the year of an older date follows the clock that is passed, not the real one', () => {
    // Far from today's real date, so a label that read Date.now would add or drop the year.
    const later = at(2030, 10, 16, 15, 30)
    inLocale('en')
    assert.equal(dayLabel(at(2030, 10, 14), later), 'Oct 14')
    assert.equal(dayLabel(at(2029, 10, 14), later), 'Oct 14, 2029')
    assert.equal(headerText(header('day', at(2030, 10, 9)), later), 'Oct 9')
    assert.equal(headerText(header('day', at(2029, 10, 9)), later), 'Oct 9, 2029')
    assert.equal(headerText(header('hour', at(2030, 10, 9, 9), true), later), 'Oct 9 · 9 AM')
    assert.equal(pinnedText(header('hour', at(2029, 10, 9, 9)), later), 'Oct 9, 2029 · 9 AM')
    assert.equal(pinnedText(header('day', at(2030, 10, 9)), later), 'Oct 9')
})

test('a date in another year carries the year', () => {
    inLocale('en')
    assert.equal(dayLabel(at(2025, 10, 14), now), 'Oct 14, 2025')
    inLocale('ja')
    assert.match(dayLabel(at(2025, 10, 14), now), /2025/)
    inLocale('fr')
    assert.match(dayLabel(at(2025, 10, 14), now), /2025/)
})

test('after the clocks go forward, a 23-hour day is still Yesterday', () => {
    // 2026-03-08 has 23 hours in New York: 02:00 EST jumps to 03:00 EDT.
    const sunday = at(2026, 3, 8, 12)
    const monday = at(2026, 3, 9, 0, 30)
    assert.equal(monday - at(2026, 3, 8, 0, 30), 23 * 3_600_000)
    inLocale('en')
    assert.equal(dayLabel(sunday, monday), en.history.yesterday)
    // The first hour of that day, before the jump, is Yesterday too.
    assert.equal(dayLabel(at(2026, 3, 8, 0, 10), monday), en.history.yesterday)
    // And the day before it is a date.
    assert.equal(dayLabel(at(2026, 3, 7, 23, 50), monday), 'Mar 7')
})

test('after the clocks go back, a 25-hour day is still Yesterday', () => {
    // 2026-11-01 has 25 hours: 02:00 EDT falls back to 01:00 EST.
    const monday = at(2026, 11, 2, 0, 30)
    assert.equal(monday - at(2026, 11, 1, 0, 30), 25 * 3_600_000)
    inLocale('en')
    assert.equal(dayLabel(at(2026, 11, 1, 0, 10), monday), en.history.yesterday)
    assert.equal(dayLabel(at(2026, 11, 1, 23, 50), monday), en.history.yesterday)
    assert.equal(dayLabel(at(2026, 10, 31, 23, 50), monday), 'Oct 31')
    // 24 hours before 00:30 on the 2nd is 01:30 EST on the 1st, which is still Yesterday.
    assert.equal(dayLabel(monday - 24 * 3_600_000, monday), en.history.yesterday)
})

test('a header says its own label, with its day when the day is not named above it', () => {
    inLocale('en')
    const evening = at(2026, 10, 15, 21, 5)
    assert.equal(headerText(header('day', at(2026, 10, 9)), now), 'Oct 9')
    assert.equal(headerText(header('hour', evening), now), '9 PM')
    assert.equal(headerText(header('hour', evening, true), now), 'Yesterday · 9 PM')
    assert.equal(headerText(header('minute', at(2026, 10, 16, 14, 41)), now), '2:41 PM')
    assert.equal(
        headerText(header('minute', at(2026, 10, 16, 14, 41), true), now),
        'Today · 2:41 PM',
    )
    assert.equal(headerText(header('hour', at(2025, 10, 14, 9), true), now), 'Oct 14, 2025 · 9 AM')
})

test('the pinned header always names its day', () => {
    inLocale('en')
    const evening = at(2026, 10, 15, 21, 5)
    assert.equal(pinnedText(header('hour', evening), now), 'Yesterday · 9 PM')
    assert.equal(pinnedText(header('hour', evening, true), now), 'Yesterday · 9 PM')
    assert.equal(pinnedText(header('minute', at(2026, 10, 16, 14, 41)), now), 'Today · 2:41 PM')
    assert.equal(pinnedText(header('day', at(2026, 10, 9)), now), 'Oct 9')
})

test('headers follow the language', () => {
    const evening = at(2026, 10, 15, 21, 5)
    inLocale('fr')
    assert.match(
        headerText(header('hour', evening, true), now),
        new RegExp(`^${fr.history.yesterday} · .*21`),
    )
    assert.match(headerText(header('minute', at(2026, 10, 16, 14, 41)), now), /^14:41$/)
    inLocale('ja')
    assert.match(
        headerText(header('hour', evening, true), now),
        new RegExp(`^${ja.history.yesterday} · .*21`),
    )
    assert.match(headerText(header('minute', at(2026, 10, 16, 14, 41)), now), /14:41/)
})

test('step counts pluralise and group digits in each language', () => {
    inLocale('en')
    assert.equal(stepsText(1), '1 step')
    assert.equal(stepsText(58), '58 steps')
    assert.equal(stepsText(1206), '1,206 steps')
    assert.equal(newerStepsText(1), '1 newer step')
    assert.equal(newerStepsText(1206), '1,206 newer steps')
    inLocale('fr')
    // French counts 0 and 1 as singular, and groups digits with a narrow no-break space.
    assert.equal(stepsText(0), '0 étape')
    assert.equal(stepsText(1), '1 étape')
    assert.equal(stepsText(2), '2 étapes')
    assert.match(stepsText(1206), /^1\s206 étapes$/)
    assert.match(newerStepsText(1206), /^1\s206 étapes plus récentes$/)
    inLocale('ja')
    assert.equal(stepsText(1206), '1,206 操作')
    assert.equal(newerStepsText(1206), '新しい操作 1,206 件')
})
