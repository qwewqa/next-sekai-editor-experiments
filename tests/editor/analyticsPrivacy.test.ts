import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
    catalogue,
    COUNT_CAP,
    MS_CAP,
    scales,
    SECONDS_CAP,
    sources,
} from '../../src/analytics/catalogue'
import { STACK_CAP } from '../../src/history/cap'

// What the usage statistics send is explained in two places. docs/usage-statistics.md lists every
// field, so a field added to the catalogue without its row fails here. The privacy page keeps the
// disclosures that do not change with a field.

const doc = readFileSync(new URL('../../docs/usage-statistics.md', import.meta.url), 'utf8')
const html = readFileSync(new URL('../../privacy/index.html', import.meta.url), 'utf8')
const page = html
    .replace(/<script\b[\s\S]*?<\/script>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')

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
    assert.ok(body !== undefined, `docs/usage-statistics.md has no section “${title}”`)
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
const families: Record<string, string[]> = {
    'frames.<state>.<length>': frameStates.flatMap((state) =>
        scales.frame.map((length) => `frames.${state}.${length}`),
    ),
    'slowEvents.<length>': scales.slowEvent.map((length) => `slowEvents.${length}`),
    'peek.<time>': scales.peek.map((time) => `peek.${time}`),
}
const familyOf = (key: string) =>
    Object.entries(families).find(([, members]) => members.includes(key))?.[0]

/** The documented name of a catalogue key: itself, or the family it belongs to. */
const documentedAs = (key: string) => familyOf(key) ?? key

const kindOf = (prop: unknown) =>
    typeof prop === 'string'
        ? prop
        : typeof prop === 'object' && prop !== null
          ? (['scale', 'oneOf', 'whole', 'pattern'].find((kind) => kind in prop) ?? '')
          : ''

const formatFits = (prop: unknown, cells: string[]) => {
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
        case 'oneOf':
            return (prop as { oneOf: readonly string[] }).oneOf.every((value) =>
                cells.join(' ').includes(`\`${value}\``),
            )
        default:
            return format.length > 0
    }
}

const measuredKeys = ['cores', 'deviceMemory', 'engine', 'touch', 'dpr', 'viewport'] as const

test('the reference explains every field of every event, and no field that is gone', () => {
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
            documented.add(name)
            const row = named.get(name)
            assert.ok(row, `${event}.${key} is not in docs/usage-statistics.md (${name})`)
            // The found.* rows list a yes-or-no each and have no format column.
            if (key.startsWith('found.')) continue
            assert.ok(formatFits(prop, row.cells), `${event}.${key}: its format does not fit`)
        }
        for (const name of named.keys())
            assert.ok(
                documented.has(name),
                `docs/usage-statistics.md lists ${event} ${name}, which the catalogue lacks`,
            )
    }
})

test('the families the reference names stand for fields the catalogue has', () => {
    for (const [family, members] of Object.entries(families)) {
        const event = family.startsWith('peek.') ? 'peek' : 'perf'
        const keys = Object.keys(catalogue[event])
        for (const member of members) assert.ok(keys.includes(member), member)
        assert.ok(section(event).includes(`\`${family}\``), family)
    }
    // Every other frame or slow-response field is a counter that is a member of a family.
    for (const key of Object.keys(catalogue.perf))
        if (/^(?:frames|slowEvents)\./.test(key) && key !== 'frames.unclassified')
            assert.ok(familyOf(key), key)
    for (const state of frameStates)
        assert.ok(section('perf').includes(`\`${state}\``), `perf: the state ${state}`)
})

test('the device details are explained once, with the values the catalogue allows', () => {
    const body = section('Device details on measured events')
    const named = byName(rows(body))
    for (const key of measuredKeys) {
        const row = named.get(key)
        assert.ok(row, key)
        assert.ok((row.cells[1] ?? '').length > 0, key)
        assert.ok(formatFits(catalogue.perf[key], row.cells), `${key}: its format does not fit`)
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
    const exact = section('How exact the values are')
    for (const words of [
        `from 0 to ${COUNT_CAP}`,
        `from 0 to ${MS_CAP}`,
        `from 0 to ${SECONDS_CAP}`,
        `up to ${STACK_CAP}.`,
        `up to ${COUNT_CAP}.`,
        'Processor cores** are exact from 1 to 32',
        'Pixel density** is exact for 1, 2 and 3',
        '**Screen size** is exact',
        '**Chart counts** are exact from 0 to 9',
        '**Music lengths and file sizes** are always ranges',
        '**A missing or invalid measurement** is left out',
    ])
        assert.ok(exact.includes(words), words)

    // The exact values the sentences name are the scales’ own.
    assert.deepEqual(scales.counts.slice(0, 10), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])
    assert.deepEqual(
        scales.cores.slice(0, 32),
        Array.from({ length: 32 }, (_, i) => String(i + 1)),
    )
    assert.deepEqual(
        scales.dpr.filter((label) => /^\d$/.test(label)),
        ['1', '2', '3'],
    )

    const ranges = rows(section('The ranges'))
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
    for (const label of ['80000-99999', '100000+', '250-319', '13-15', '80-99'])
        assert.ok(scales.counts.includes(label) && all.includes(`\`${label}\``), label)
    const decade = scales.counts.slice(10, 20).map((label) => label.split('-')[0])
    assert.deepEqual(decade, ['10', '13', '16', '20', '25', '32', '40', '50', '63', '80'])
    assert.ok(all.includes(`start at ${decade.slice(0, -1).join(', ')} and ${decade.at(-1)}`))
    for (const label of scales.cores.slice(32))
        assert.ok(all.includes(`\`${label}\``), `cores: ${label}`)
})

test('the privacy page keeps its disclosures', () => {
    for (const words of [
        // What stays on the device, and what is sent after the first interaction.
        'Your charts, editing history and stored assets stay on your device',
        'The web editor works without accounts or cookies and does not send crash reports',
        'No statistics are sent before your first interaction',
        // The default, the browser signals, the switch and what resets it.
        'Turn off Settings › About › Send Usage Statistics to stop sending immediately',
        'Statistics are on by default unless your browser sends Do Not Track or Global Privacy Control',
        'Your choice applies to this browser only',
        'Clearing the site’s data resets it, so statistics are on again unless your browser sends either signal',
        // Ranges, and what they can reveal.
        'Chart sizes, music lengths and file sizes are sent as ranges, except that chart object counts below 10 are sent exactly',
        'Together these figures can sometimes match a published chart',
        // What the server receives, and the daily code.
        'The statistics server receives your IP address and user agent',
        'only country, browser, operating system and device type are stored in the statistics',
        'a daily visitor code made from your IP address and user agent',
        'The statistics server sets no cookies and stores nothing in your browser',
        // How long it is kept, and what the totals hold.
        'We keep individual usage statistics for 13 months',
        'We keep monthly and weekly totals indefinitely',
        'combined figures with no visitor codes',
        'Small groups are combined into larger groups or omitted',
        'Backups on AWS are deleted after about five weeks',
        'We delete these logs after two weeks',
        // Where it is processed.
        'GitHub may log requests, including your IP address',
        'servers in the United States',
        'is the only provider with whom we share these statistics',
        'European Commission’s Standard Contractual Clauses',
        // Email, files, the older browser, the controller and the rights.
        'If you send a file to help fix a problem, we use it only for that and delete it when the problem is fixed',
        'keep it out of public issues',
        'reports the browser family, such as Firefox or Safari, and that it is unsupported',
        'qwewqa runs this site and is responsible for the use of personal data described here',
        'You may also complain to your local data protection authority',
    ])
        assert.ok(page.includes(words), `the privacy page lacks “${words}”`)
})

test('the privacy page lists the categories, and links to the complete list', () => {
    for (const category of [
        'Tools and Settings.',
        'Files and Charts.',
        'Performance.',
        'Browser and Device.',
        'Storage.',
        'Referring Sites.',
    ])
        assert.ok(page.includes(category), category)

    const start = html.indexOf('aria-labelledby="usage"')
    const usage = html.slice(start, html.indexOf('aria-labelledby="hosting"'))
    assert.ok(start > 0 && usage.length > 0)
    const link =
        /<a\s+href="https:\/\/github\.com\/%GITHUB_REPOSITORY%\/blob\/main\/docs\/usage-statistics\.md"[^>]*>\s*complete list of what is sent\s*<\/a\s*>/
    assert.match(usage, link)
    assert.doesNotMatch(html, /docs\/analytics\.md/)
})
