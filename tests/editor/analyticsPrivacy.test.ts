import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { catalogue } from '../../src/analytics/catalogue'

// Every value the usage statistics send has a line on the privacy page that names it. Each
// property maps to a category, and each category to words the page must contain, so a property
// added without its line on the page fails here.

const page = readFileSync(new URL('../../privacy/index.html', import.meta.url), 'utf8')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')

/** Each category, and the words of its line on the page. */
const categories = {
    use: 'how often each tool, command and kind of edit is used, and how it was started',
    settings: 'the main settings',
    files: 'the kind and approximate size of files you open, save, export and check',
    saved: 'what a save included',
    music: 'the approximate length of music files',
    outcome: 'and whether that worked',
    chart: 'the approximate size of the chart, such as “250 to 319 notes”, whether it has music',
    undo: 'how many steps the Undo window holds',
    sessions: 'how many sessions Recent Sessions lists',
    start: 'how a visit started',
    notices: 'how many notices and errors appeared, without their messages',
    times: 'how long startup takes, how long it takes to open, save, export and check files and to load music',
    prepared: 'how long a file takes to prepare for saving or export',
    check: 'whether Check File and History found problems, and whether it checked a file as well as History',
    loaded: 'how the page was loaded, such as by a reload or from the browser’s cache, whether it was hidden while it started, and whether the browser had discarded it earlier',
    peek: 'how long the chart takes to show at a Timeline step',
    slow: 'how often the editor is slow to respond',
    lasted: 'how long the editor was visible and how long playback ran while it was, in seconds, up to one day',
    version:
        'the editor’s version, whether it was updated since your last visit, and whether this browser has used it before',
    system: 'your operating system, browser and its language',
    screen: 'your screen size and pixel density, an approximate window size and whether it is taller than wide',
    touch: 'whether the screen is a touch screen',
    cores: 'the number of processor cores and the approximate memory the browser reports',
    device: 'also carry your browser, whether the screen is a touch screen, the window size, pixel density, processor cores and memory',
    preview: 'whether the preview could use graphics and draw in parallel',
    installed: 'whether the editor is installed',
    storage: 'whether this browser’s storage is available, and approximately how full it is',
    cleanup: 'whether automatic cleanup ran, freed space or was unable to finish',
    referrer: 'the site you came from',
    time: 'Each is sent with the time it happened.',
}
type Category = keyof typeof categories

/** What need not be on the page: values that are the same in every request. */
const unlisted: Record<string, string> = {
    'pageview.website': 'our id for the site; the same in every request',
    'pageview.url': 'always /',
    'pageview.title': 'always empty',
    'pageview.hostname': 'which of our two sites; the same in every request',
    'visit.site': 'which of our two sites, as the hostname',
}

/** The category of each property, by `<event>.<key>`; the first match wins. */
const rules: [RegExp, Category][] = [
    [/^pageview\.language$/, 'settings'],
    [/^pageview\.screen$/, 'screen'],
    [/^pageview\.referrer$/, 'referrer'],
    [/^pageview\.timestamp$/, 'time'],
    [/^visit\.(?:version|returning|updated)$/, 'version'],
    [/^visit\.(?:os|engine|browserLanguage)$/, 'system'],
    [/^unsupported\./, 'system'],
    [/^visit\.(?:viewport|viewportPortrait|dpr)$/, 'screen'],
    [/^visit\.(?:cores|deviceMemory)$/, 'cores'],
    [/^visit\.touch$/, 'touch'],
    [/^visit\.standalone$/, 'installed'],
    [/^settings\./, 'settings'],
    [/^startup\.ready$/, 'times'],
    [/^startup\.(?:navigation|documentDelivery|hidden|wasDiscarded)$/, 'loaded'],
    [/^startup\.(?:cores|deviceMemory|engine|touch|dpr|viewport)$/, 'device'],
    [/^startup\./, 'start'],
    [/^storage\.sessions$/, 'sessions'],
    [/^storage\.cleanup$/, 'cleanup'],
    [/^storage\./, 'storage'],
    [/^chart\.historySteps$/, 'undo'],
    [/^chart\./, 'chart'],
    [/^preview\.graphics$/, 'preview'],
    [/^preview\./, 'preview'],
    [/^(?:open|save|export|bgm)\.took$/, 'times'],
    [/^(?:save|export)\.buildMs$/, 'prepared'],
    [
        /^(?:open|save|export|check|bgm|perf|peek)\.(?:cores|deviceMemory|engine|touch|dpr|viewport)$/,
        'device',
    ],
    [/^bgm\.length$/, 'music'],
    [/^save\.(?:history|bgm)$/, 'saved'],
    [/^(?:open|save|export|bgm)\.(?:outcome|reason|step)$/, 'outcome'],
    [/^(?:open|save|export|bgm)\./, 'files'],
    [/^check\.took$/, 'times'],
    [/^check\.size$/, 'files'],
    [/^check\.(?:outcome|scope)$/, 'check'],
    [/^(?:usage|edits|features)\./, 'use'],
    [/^(?:notices|errors)\./, 'notices'],
    [/^peek\.peek\./, 'peek'],
    [/^perf\.(?:playSeconds|visibleTime)$/, 'lasted'],
    [/^perf\.previewHost$/, 'preview'],
    [/^perf\.previewRenderScale$/, 'settings'],
    [/^perf\./, 'slow'],
]

const properties = [
    ...['website', 'url', 'title', 'hostname', 'language', 'screen', 'referrer', 'timestamp'].map(
        (key) => `pageview.${key}`,
    ),
    'usage.<command>.<source>',
    ...Object.entries(catalogue).flatMap(([name, props]) =>
        Object.keys(props).map((key) => `${name}.${key}`),
    ),
]

test('every property sent has its line on the privacy page', () => {
    const used = new Set<Category>()
    for (const property of properties) {
        if (property in unlisted) continue
        const category = rules.find(([pattern]) => pattern.test(property))?.[1]
        assert.ok(category, `${property} has no category`)
        used.add(category)
    }
    for (const [category, words] of Object.entries(categories)) {
        assert.ok(used.has(category as Category), `${category} names no property`)
        assert.ok(page.includes(words), `the privacy page lacks “${words}” (${category})`)
    }
})

test('the privacy page says how times and chart sizes are sent, and what ranges can match', () => {
    for (const words of [
        'How long an action takes is sent in milliseconds, up to ten minutes.',
        'Chart object counts below 10 are sent exactly. Larger counts, music lengths and file sizes are sent as ranges. Together these figures can sometimes match a published chart.',
    ])
        assert.ok(page.includes(words), words)
})
