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
    files: 'the kind and approximate size of files you open, save and export',
    saved: 'what a save included',
    music: 'the approximate length of music files',
    outcome: 'and whether that worked',
    chart: 'the approximate size of the chart and of its Timeline',
    sessions: 'how many sessions Recent Sessions lists',
    start: 'how a visit started',
    notices: 'how many notices and errors appeared, without their messages',
    times: 'how long startup takes, how long it takes to open, save, export and check files and to load music',
    check: 'whether Check File and History found problems',
    peek: 'how long the chart takes to show at a Timeline step',
    slow: 'how often the editor is slow to respond',
    lasted: 'approximately how long playback and the visit lasted',
    version:
        'the editor’s version, whether it was updated since your last visit, and whether this browser has used it before',
    system: 'your operating system, browser and its language',
    screen: 'your screen size and pixel density, an approximate window size',
    touch: 'whether the screen is a touch screen',
    cores: 'the number of processor cores as a range',
    preview: 'whether the preview could use graphics and draw in parallel',
    installed: 'whether the editor is installed',
    storage:
        'whether this browser’s storage is available, whether this looks like a private window, and approximately how full it is',
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
    [/^visit\.(?:viewport|dpr)$/, 'screen'],
    [/^visit\.touch$/, 'touch'],
    [/^visit\.standalone$/, 'installed'],
    [/^settings\./, 'settings'],
    [/^startup\.ready$/, 'times'],
    [/^startup\./, 'start'],
    [/^storage\.sessions$/, 'sessions'],
    [/^storage\./, 'storage'],
    [/^chart\.bgm$/, 'music'],
    [/^chart\./, 'chart'],
    [/^preview\.graphics$/, 'preview'],
    [/^preview\./, 'preview'],
    [/^(?:open|save|export|bgm)\.took$/, 'times'],
    [/^bgm\.length$/, 'music'],
    [/^save\.(?:history|bgm)$/, 'saved'],
    [/^(?:open|save|export|bgm)\.(?:outcome|reason|step)$/, 'outcome'],
    [/^(?:open|save|export|bgm)\./, 'files'],
    [/^check\.took$/, 'times'],
    [/^check\.outcome$/, 'check'],
    [/^(?:usage|edits|features)\./, 'use'],
    [/^(?:notices|errors)\./, 'notices'],
    [/^perf\.peek\./, 'peek'],
    [/^perf\.(?:playSeconds|visibleTime)$/, 'lasted'],
    [/^perf\.cores$/, 'cores'],
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
