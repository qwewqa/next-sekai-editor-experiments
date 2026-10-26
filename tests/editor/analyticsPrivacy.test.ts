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
    use: 'How often each tool, command and kind of edit is used, and how it was started',
    settings: 'the main settings, such as theme, language and whether the minimap is shown',
    files: 'The kind and approximate size of files you open, save, export and check',
    saved: 'what a save included',
    music: 'the approximate length of music files',
    outcome: 'whether each action worked',
    chart: 'the approximate chart size, such as “250 to 319 notes”, whether the chart has music',
    undo: 'how many steps the Undo window holds',
    sessions: 'how many sessions Recent Sessions lists',
    start: 'how a visit started, such as recovering earlier work',
    notices: 'For notices and errors, the editor sends counts only',
    times: 'how long startup takes; how long it takes to open, save, export and check files and load music',
    prepared: 'how long a file takes to prepare for saving or export',
    check: 'Check File and History found problems and whether the check included a file as well as History',
    loaded: 'How the page was loaded, such as by a reload or from the browser’s cache, whether it was hidden during startup, and whether the browser had discarded it earlier',
    peek: 'how long the chart takes to show at a Timeline step',
    slow: 'how often it is slow to respond, the number of clicks and key presses',
    lasted: 'Time spent with the editor visible and time spent playing while it is visible are sent in seconds, up to one day',
    version:
        'The editor’s version, whether it was updated since your last visit, and whether this browser has used it before',
    system: 'your operating system, browser and its language',
    screen: 'screen size and pixel density, approximate window size and whether it is taller than wide',
    touch: 'whether your main way of pointing is imprecise, such as a finger on a touch screen',
    cores: 'The browser supplies the number of processor cores, approximate memory',
    device: 'Measurements of startup, files, music, Timeline steps and slow responses also include the browser, pointing precision, window size, pixel density, processor cores and memory described above',
    preview: 'whether the preview could use graphics and draw in parallel',
    installed: 'whether the editor is running in a window of its own',
    storage:
        'Whether this browser’s storage is available, its approximate capacity and how full it is, whether the browser has granted protection from automatic clearing',
    cleanup: 'whether automatic cleanup ran, freed space or was unable to finish',
    referrer: 'the editor sends its protocol, domain and any non-default port',
    time: 'Each report includes a timestamp',
    supports: 'which performance measurements the browser supports',
    unsupported:
        'sends the browser family, such as Firefox or Safari, and an indication that the browser is unsupported',
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
    [/^unsupported\./, 'unsupported'],
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
    [/^perf\.(?:loafSupported|eventTimingSupported)$/, 'supports'],
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
        'Startup and file or music action times are sent in whole milliseconds, up to ten minutes per measurement.',
        'Chart object counts below 10 are sent exactly. Larger counts, music lengths and file sizes are sent as ranges. Together these figures can sometimes match a published chart.',
    ])
        assert.ok(page.includes(words), words)
})
