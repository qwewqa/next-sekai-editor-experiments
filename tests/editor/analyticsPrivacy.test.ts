import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
    bucket,
    catalogue,
    COUNT_CAP,
    MS_CAP,
    scales,
    SECONDS_CAP,
    sources,
} from '../../src/analytics/catalogue'
import { shouldSend, type Inputs } from '../../src/analytics/config'
import { editKey, startKind } from '../../src/analytics/rules'
import * as tally from '../../src/analytics/tally'
import { endOpen, startOpen } from '../../src/editor/commands/open/report'
import type { HistoryAction } from '../../src/history/actions'
import { STACK_CAP } from '../../src/history/cap'

// What the usage statistics send is explained in two places. docs/usage-statistics.md lists every
// field that is sent, so a field added to the catalogue without its row fails here. The privacy
// page keeps the disclosures that do not change with a field. The catalogue allows more than is
// sent today; the tests below tie the difference to the code that produces each value.

const doc = readFileSync(new URL('../../docs/usage-statistics.md', import.meta.url), 'utf8')
const html = readFileSync(new URL('../../privacy/index.html', import.meta.url), 'utf8')

/** The body of each heading of the reference, up to the next heading. */
const sections = new Map<string, string>()
const headings = [...doc.matchAll(/^#{2,4} (.+)$/gm)]
headings.forEach((heading, i) => {
    const title = (heading[1] ?? '').replaceAll('`', '')
    const end = headings[i + 1]?.index ?? doc.length
    sections.set(title, doc.slice((heading.index ?? 0) + heading[0].length, end))
})
const section = (title: string) => {
    const body = sections.get(title)
    assert.ok(body !== undefined, `docs/usage-statistics.md has no section "${title}"`)
    return body
}

const tokens = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map(([, token = '']) => token)

type Row = { cells: string[]; names: string[] }
/** The table rows of a section: the cells, and the names in backticks in the first cell. */
const rows = (body: string): Row[] =>
    body
        .split('\n')
        .filter((line) => line.startsWith('|') && !/^\|[\s|-]+\|$/.test(line))
        .map((line) =>
            line
                .slice(1, -1)
                .split('|')
                .map((cell) => cell.trim()),
        )
        .filter((cells) => cells[0] !== 'Field' && cells[0] !== 'Range')
        .map((cells) => ({ cells, names: tokens(cells[0] ?? '') }))

const byName = (list: Row[]) =>
    new Map(list.flatMap((row) => row.names.map((name): [string, Row] => [name, row])))

/** The field families the reference names once, and the fields each stands for. */
const frameStates = ['playing', 'busy', 'other']
const panels = ['preview', 'groups', 'stages', 'properties', 'history']
const sides = ['left', 'right', 'top']
const families: Record<string, { event: keyof typeof catalogue; members: string[] }> = {
    'frames.<state>.<length>': {
        event: 'perf',
        members: frameStates.flatMap((state) =>
            scales.frame.map((length) => `frames.${state}.${length}`),
        ),
    },
    'slowEvents.<length>': {
        event: 'perf',
        members: scales.slowEvent.map((length) => `slowEvents.${length}`),
    },
    'peek.<time>': { event: 'peek', members: scales.peek.map((time) => `peek.${time}`) },
    'panelSeconds.<panel>.<place>': {
        event: 'layout',
        members: panels.flatMap((panel) =>
            [...sides, 'covered'].map((place) => `panelSeconds.${panel}.${place}`),
        ),
    },
    'dockSizeSeconds.<side>.<size>': {
        event: 'layout',
        members: sides.flatMap((side) =>
            scales.dockSize.map((size) => `dockSizeSeconds.${side}.${size}`),
        ),
    },
    'previewShareSeconds.<share>': {
        event: 'layout',
        members: scales.previewShare.map((share) => `previewShareSeconds.${share}`),
    },
}
const familyOf = (key: string) =>
    Object.entries(families).find(([, { members }]) => members.includes(key))?.[0]

/** The documented name of a catalogue key: itself, or the family it belongs to. */
const documentedAs = (key: string) => familyOf(key) ?? key

const kindOf = (prop: unknown) =>
    typeof prop === 'string'
        ? prop
        : typeof prop === 'object' && prop !== null
          ? (['scale', 'oneOf', 'whole', 'pattern'].find((kind) => kind in prop) ?? '')
          : ''

/** What the catalogue allows and nothing sends today. The reference leaves it out. */
const unused: Record<string, readonly string[]> = {
    'startup.start': ['launchFile', 'safeMode'],
    'open.via': ['drop', 'launch'],
    'open.reason': ['conflict', 'not-found', 'denied', 'not-local', 'no-space', 'read-only', 'io'],
    'export.format': ['other'],
    'export.outcome': ['cancelled'],
}
/** The `edits` keys that the client never counts: see `editKey`. */
const unusedEdits = ['origin', 'continue', 'recovery', 'externalChange', 'file.save', 'file.export']

const formatFits = (prop: unknown, row: Row, unusedValues: readonly string[] = []) => {
    const cells = row.cells
    const format = cells[2] ?? ''
    if (/^As above$/i.test(format)) return true
    switch (kindOf(prop)) {
        case 'boolean':
            return /yes or no/i.test(format)
        case 'count':
            return /count/i.test(format)
        case 'ms':
            return /milliseconds/i.test(format)
        case 'seconds':
            return /seconds/i.test(format)
        case 'scale':
            return /range|exact/i.test(format)
        case 'whole':
            return /exact/i.test(format)
        case 'oneOf': {
            const sent = (prop as { oneOf: readonly string[] }).oneOf.filter(
                (value) => !unusedValues.includes(value),
            )
            const listed = row.names.length === 1 ? tokens(format) : sent
            return (
                sent.every((value) => cells.join(' ').includes(`\`${value}\``)) &&
                listed.every((value) => sent.includes(value))
            )
        }
        default:
            return format.length > 0
    }
}

const measuredKeys = [
    'cores',
    'deviceMemory',
    'engine',
    'touch',
    'dpr',
    'viewport',
    'viewportHeight',
    'viewportAspect',
] as const

test("the reference covers the catalogue's fields and leaves out what nothing sends", () => {
    const events = [...Object.keys(catalogue), 'usage']
    for (const event of events) {
        const eventRows = rows(section(event))
        const named = byName(eventRows)
        for (const row of eventRows)
            assert.ok(
                (row.cells[1] ?? '').length > 0,
                `${event}: ${row.names.join(', ')} has no meaning`,
            )

        if (event === 'usage') {
            assert.deepEqual([...named.keys()], ['<command>.<source>'])
            for (const source of sources)
                assert.ok(section(event).includes(`\`${source}\``), `usage: the source ${source}`)
            continue
        }

        const props = catalogue[event as keyof typeof catalogue] as Record<string, unknown>
        const documented = new Set<string>()
        for (const [key, prop] of Object.entries(props)) {
            const name = documentedAs(key)
            if (event === 'edits' && unusedEdits.includes(key)) {
                assert.ok(!named.has(name), `edits.${key} is not counted, so it is not listed`)
                continue
            }
            documented.add(name)
            const row = named.get(name)
            assert.ok(row, `${event}.${key} is not in docs/usage-statistics.md (${name})`)
            // The found.* rows list a yes-or-no each and have no format column.
            if (key.startsWith('found.')) continue
            assert.ok(
                formatFits(prop, row, unused[`${event}.${key}`]),
                `${event}.${key}: its format does not fit`,
            )
        }
        for (const name of named.keys())
            assert.ok(
                documented.has(name),
                `docs/usage-statistics.md lists ${event} ${name}, which the catalogue lacks`,
            )
    }
})

test('the families the reference names stand for fields the catalogue has', () => {
    for (const [family, { event, members }] of Object.entries(families)) {
        const keys = Object.keys(catalogue[event])
        for (const member of members) assert.ok(keys.includes(member), member)
        assert.ok(section(event).includes(`\`${family}\``), family)
    }
    // Every other frame, slow-response or layout-time field is a counter that is a member of a family.
    for (const key of Object.keys(catalogue.perf))
        if (/^(?:frames|slowEvents)\./.test(key) && key !== 'frames.unclassified')
            assert.ok(familyOf(key), key)
    for (const key of Object.keys(catalogue.layout))
        if (/^(?:panelSeconds|dockSizeSeconds|previewShareSeconds)\./.test(key))
            assert.ok(familyOf(key), key)
    for (const state of frameStates)
        assert.ok(section('perf').includes(`\`${state}\``), `perf: the state ${state}`)
})

test('the device details are explained once, with the values the catalogue allows', () => {
    const body = section('Device Details in Events')
    const named = byName(rows(body))
    for (const key of measuredKeys) {
        const row = named.get(key)
        assert.ok(row, key)
        assert.ok((row.cells[1] ?? '').length > 0, key)
        assert.ok(formatFits(catalogue.perf[key], row), `${key}: its format does not fit`)
    }
    // Each event that repeats them lists them in a row of its own.
    for (const [event, props] of Object.entries(catalogue))
        if (measuredKeys.every((key) => key in props) && event !== 'visit')
            for (const key of measuredKeys)
                assert.ok(
                    rows(section(event)).some((row) => row.names.includes(key)),
                    `${event}.${key}`,
                )
})

test('the reference states the exact values, the caps and the ranges', () => {
    const exact = section('How Exact the Values Are')
    for (const words of [
        `from 0 to ${COUNT_CAP}`,
        `from 0 to ${MS_CAP}`,
        `from 0 to ${SECONDS_CAP}`,
        `up to ${STACK_CAP}.`,
        `up to ${COUNT_CAP}.`,
        'Processor cores** are exact from 1 to 32',
        'Pixel density** is exact for 1, 1.25, 1.5, 1.75, 2 and 3',
        '**Screen size** is exact',
        '**Chart counts** are exact from 0 to 9',
        '**Music lengths and file sizes** are always ranges',
        '**A missing or invalid measurement** is left out',
    ])
        assert.ok(exact.includes(words), words)

    // The exact values the sentences name are the scales' own.
    assert.deepEqual(scales.counts.slice(0, 10), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])
    assert.deepEqual(
        scales.cores.slice(0, 32),
        Array.from({ length: 32 }, (_, i) => String(i + 1)),
    )
    const exactDpr = scales.dpr.filter((label) => /^[\d.]+$/.test(label))
    assert.deepEqual(exactDpr, ['1', '1.25', '1.5', '1.75', '2', '3'])
    // Every passage that names the exact pixel densities lists the same ones.
    const lastDpr = exactDpr.at(-1)
    const firstDpr = exactDpr.slice(0, -1).join(', ')
    for (const row of doc.split('\n').filter((line) => line.startsWith('| `dpr` |')))
        assert.ok(row.includes(`Exact for ${firstDpr} and ${lastDpr}, a range otherwise`), row)
    assert.ok(section('The Ranges').includes(`start at ${firstDpr} or ${lastDpr} exclude`))

    const ranges = rows(section('The Ranges'))
    const all = ranges.map((row) => row.cells.join(' ')).join('\n')
    // Each scale is in a row that names the fields it is used for, with all of its labels. The
    // chart counts and the cores describe their labels in words, so a few labels stand for them.
    const written: Record<string, number> = { counts: 0, cores: 0 }
    for (const [event, props] of Object.entries(catalogue))
        for (const [key, prop] of Object.entries(props as Record<string, unknown>)) {
            if (kindOf(prop) !== 'scale') continue
            const name = documentedAs(key)
            const scale = (prop as { scale: keyof typeof scales }).scale
            const row = ranges.find((candidate) => candidate.cells[1]?.includes(`\`${name}\``))
            assert.ok(row, `${event}.${key}: no row of The ranges names ${name}`)
            if (scale in written) continue
            for (const label of scales[scale])
                assert.ok(row.cells[2]?.includes(`\`${label}\``), `${scale}: ${label}`)
        }
    // The boundary rule names the labels where the code differs from the usual lower-inclusive range.
    const rule = section('The Ranges').split('\n\n')[1] ?? ''
    for (const [scale, value, label] of [
        ['usageShare', 80, '70-80'],
        ['usageShare', 80.5, '80-90'],
        ['noteSpeed', 10.1, '10-10.5'],
        ['noteSpeed', 12, '11.5-12'],
        ['counts', 15, '13-15'],
        ['cores', 48, '33-48'],
    ] as const) {
        assert.equal(bucket(scale, value), label, `${scale} ${value}`)
        if (scale !== 'counts' && scale !== 'cores')
            assert.ok(rule.includes(label), `the range rule names ${label}`)
    }
    for (const label of ['80000-99999', '100000+', '250-319', '13-15', '80-99'])
        assert.ok(scales.counts.includes(label) && all.includes(`\`${label}\``), label)
    const decade = scales.counts.slice(10, 20).map((label) => label.split('-')[0])
    assert.deepEqual(decade, ['10', '13', '16', '20', '25', '32', '40', '50', '63', '80'])
    assert.ok(all.includes(`start at ${decade.slice(0, -1).join(', ')} and ${decade.at(-1)}`))
    for (const label of scales.cores.slice(32))
        assert.ok(all.includes(`\`${label}\``), `cores: ${label}`)
})

const plain = (markup: string) =>
    markup
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

/** The markup of one section of the page, by the id its heading carries. */
const sectionHtml = (id: string) => {
    const start = html.indexOf(`aria-labelledby="${id}"`)
    const end = html.indexOf('</section>', start)
    assert.ok(start > 0 && end > start, `the privacy page has no section ${id}`)
    return html.slice(start, end)
}

/** The text of one section of the page. */
const sectionText = (id: string) => plain(sectionHtml(id))

/** The markup inside each paragraph and list item of a section. */
const elements = (id: string) =>
    [...sectionHtml(id).matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/g)].map(
        ([, , inner = '']) => inner,
    )

/** What each section must keep disclosing: the setting path, the signals, the legal bases, the recipients and the periods. Each pattern names a value, not a sentence. */
const disclosures: Record<string, RegExp[]> = {
    summary: [
        /Settings › About › Send Usage Statistics/,
        /Do Not Track/,
        /Global Privacy Control/,
        /does not require an account/,
        /or use cookies/,
    ],
    who: [/qwewqa/, /nse@qwewqa\.dev/],
    usage: [
        /visitor identifier/,
        /estimate your country/,
        /error logs on the statistics server may contain it/,
    ],
    hosting: [/GitHub/, /Amazon Web Services \(AWS\)/, /United States/, /email provider/],
    contact: [/email address, message and any attachments/, /delete it once the problem is fixed/],
    basis: [
        /Legitimate interest: improving the editor and answering your messages/,
        /Legal obligation: answering requests to exercise your data protection rights/,
    ],
    choices: [
        /access, correct or delete/,
        /copy in a reusable format/,
        /have the right to complain to your local data protection authority/,
    ],
}

test('the privacy page keeps its disclosures', () => {
    for (const [id, patterns] of Object.entries(disclosures))
        for (const pattern of patterns)
            assert.match(sectionText(id), pattern, `the ${id} section no longer covers ${pattern}`)
})

test('the legal basis names legitimate interest once and a legal obligation, and the rights include the complaint', () => {
    const basis = sectionText('basis')
    assert.equal(sectionHtml('basis').match(/<li\b/g)?.length, 2)
    assert.equal(basis.match(/Legitimate interest/g)?.length, 1)
    assert.match(basis, /Legitimate interest: improving the editor and answering your messages/)
    assert.match(basis, /Legal obligation: .*data protection rights/)
    assert.match(sectionText('choices'), /You also have the right to complain to /)
})

test('the hosting section names no transfer clauses', () => {
    assert.doesNotMatch(sectionText('hosting'), /Standard Contractual Clauses/)
    assert.doesNotMatch(html, /aws\.amazon\.com/)
})

test('each retention period is stated with its data', () => {
    const periods: [RegExp, RegExp[]][] = [
        [/Individual usage records/, [/up to 13 months/]],
        [/Backups of the statistics/, [/up to six weeks after each backup is made/]],
        [/Error logs on the statistics server/, [/up to two weeks/]],
        [/Email conversations/, [/up to one year after your last message/]],
        [/Aggregated statistics/, [/no visitor identifiers/, /indefinitely/]],
    ]
    const texts = elements('keep').map(plain)
    for (const [data, values] of periods)
        assert.ok(
            texts.some((text) => data.test(text) && values.every((value) => value.test(text))),
            `the keep section no longer ties ${data} to ${values.join(' and ')}`,
        )
})

test('a separate paragraph offers the objection, and one email link covers the rights', () => {
    const parts = [
        /object/,
        /usage statistics/,
        /support/,
        /at any time/,
        /Settings › About › Send Usage Statistics/,
    ]
    const paragraphs = elements('choices')
    const objection = paragraphs.filter((markup) => parts.every((part) => part.test(plain(markup))))
    assert.equal(objection.length, 1, 'one paragraph of the rights section offers the objection')
    const general = paragraphs.find((markup) => /access, correct or delete/.test(plain(markup)))
    assert.ok(
        general && general !== objection[0],
        'the general rights are a paragraph of their own',
    )
    const links = sectionHtml('choices').match(/<a\s+href="mailto:nse@qwewqa\.dev"/g)
    assert.equal(links?.length, 1, 'one email link covers all the rights')
    assert.match(sectionText('choices'), /To exercise any of these rights, email/)
})

test('the privacy page links to the usage statistics reference', () => {
    const usage = sectionHtml('usage')
    const link =
        /<a\s+href="https:\/\/github\.com\/%GITHUB_REPOSITORY%\/blob\/main\/docs\/usage-statistics\.md"[^>]*>\s*What Usage Statistics Contain\s*<\/a\s*>/

    assert.match(usage, link)
    assert.doesNotMatch(html, /docs\/analytics\.md/)
})

const action = (kind: string, operation?: unknown) =>
    ({ kind, step: { operation } }) as unknown as HistoryAction

test('the reference leaves out what the code that produces each value never sends', () => {
    // startup.start: every combination a visit can start with.
    const starts = new Set<string>()
    for (const reloaded of [false, true])
        for (const kinds of [
            [],
            ['continued'],
            ['journalRecovered'],
            ['unsavedRecovered'],
            ['journalKept'],
            ['continued', 'journalKept'],
        ])
            starts.add(startKind(false, new Set(kinds), reloaded))
    assert.deepEqual(
        [...starts].sort(),
        catalogue.startup.start.oneOf.filter((v) => !unused['startup.start']?.includes(v)).sort(),
    )
    // A start in safe mode is never sent.
    const inputs: Inputs = {
        target: { origin: 'https://stats.example', website: 'x' },
        fromTestKey: false,
        choice: true,
        signal: false,
        webdriver: false,
        hostname: 'nse.qwewqa.dev',
        site: 'production',
        safeMode: false,
        saveData: false,
    }
    assert.ok(shouldSend(inputs))
    assert.ok(!shouldSend({ ...inputs, safeMode: true }))

    // open.via and open.outcome: what endOpen records, which takes only two reasons.
    tally.enable()
    try {
        const sent: Record<string, Set<unknown>> = {
            via: new Set(),
            outcome: new Set(),
            reason: new Set(),
        }
        for (const [outcome, reason] of [
            ['done'],
            ['cancelled'],
            ['failed'],
            ['refused', 'unsupported'],
            ['refused', 'invalid'],
        ] as const) {
            startOpen({ size: 1 } as File)
            endOpen(outcome, reason)
        }
        for (const { data } of tally.collect().recorded)
            for (const key of Object.keys(sent)) if (key in data) sent[key]?.add(data[key])
        assert.deepEqual([...(sent.via ?? [])], ['picker'])
        assert.deepEqual([...(sent.outcome ?? [])].sort(), [...catalogue.open.outcome.oneOf].sort())
        assert.deepEqual([...(sent.reason ?? [])].sort(), ['invalid', 'unsupported'])
    } finally {
        tally.disable()
    }
})

test('an export records only its write, as a level file, done or failed', () => {
    const flow = readFileSync(
        new URL('../../src/editor/commands/exportLevel/flow.ts', import.meta.url),
        'utf8',
    )
    const record = /record\(\s*'export',\s*\{([\s\S]*?)\},\s*writeStarted/.exec(flow)?.[1] ?? ''
    assert.match(record, /format: 'levelData'/)
    assert.match(record, /outcome: error \? 'failed' : 'done'/)
})

test('edits count Undo, Redo, edits and restores, and nothing else', () => {
    assert.equal(editKey(action('undo')), 'undo')
    assert.equal(editKey(action('redo')), 'redo')
    assert.equal(editKey(action('edit', { id: 'nse.note.add' })), 'note.add')
    assert.equal(editKey(action('restore', { id: 'nse.restore' })), 'restore')
    for (const kind of ['reset', 'save', 'export'])
        assert.equal(editKey(action(kind, { id: 'nse.origin' })), undefined, kind)
    for (const key of unusedEdits) assert.ok(key in catalogue.edits, key)
})
