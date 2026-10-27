import { ESLint, RuleTester, type Rule } from 'eslint'
import assert from 'node:assert/strict'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it, test } from 'node:test'
import vueParser from 'vue-eslint-parser'
import local from '../../../scripts/eslint-plugin-local.mjs'

// The two History rules of the local lint plugin: `local/no-local-time` keeps
// local time reads in the calendar module, and `local/history-imports` keeps History's date and
// time formatting on the History clock. The rule tests run through RuleTester; the real
// eslint.config.js is asked which files each rule covers and whether, with the native-code bans,
// they still fire together.

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const root = path.resolve(import.meta.dirname, '../../..')
const history = `${root}/src/editor/history/TimelineList.vue`.replace('.vue', '.ts')
const ruleTester = new RuleTester({
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
})

const messageOf = (messageId: string) => ({ messageId })

const rules = local.rules as unknown as Record<string, Rule.RuleModule>

ruleTester.run('local/no-local-time', rules['no-local-time']!, {
    valid: [
        // The calendar module's own functions and plain numbers.
        { code: 'dayKey(time, zone)', filename: history },
        { code: 'const d = new Date(time)', filename: history },
        { code: 'new Date(1700000000000)', filename: history },
        { code: 'new Date(a + b)', filename: history },
        { code: 'Date.UTC(2026, 9, 20)', filename: history },
        { code: 'date.getUTCHours()', filename: history },
        { code: 'date.getTime()', filename: history },
        { code: 'date.toISOString()', filename: history },
        { code: 'performance.now()', filename: history },
        { code: 'const f = fields.hour', filename: history },
        // Accepted residuals: a value that was copied or aliased, a computed key, and
        // Date#toLocaleString are not seen by name. formatZones and the one-Calendar test back them.
        { code: 'const D = Date; D.now()', filename: history },
        { code: 'const read = (d) => d[key]()', filename: history },
        { code: 'date.toLocaleString()', filename: history },
        { code: 'import(name)', filename: history },
        { code: 'import(`../i18n/${name}`)', filename: history },
        { code: 'const { UTC } = Date', filename: history },
        // Date.now() is only banned under src/editor/history, and calendarClock.ts reads it.
        { code: 'const now = Date.now()', filename: `${root}/src/editor/history/calendarClock.ts` },
        { code: 'const now = Date.now()', filename: `${root}/src/history/session.ts` },
        { code: 'const now = Date.now()', filename: `${root}/src/local/days.ts` },
    ],
    invalid: [
        ...[
            'getFullYear',
            'getYear',
            'getMonth',
            'getDate',
            'getDay',
            'getHours',
            'getMinutes',
            'getSeconds',
            'getMilliseconds',
            'setFullYear',
            'setMonth',
            'setDate',
            'setHours',
            'setMinutes',
            'setSeconds',
            'setMilliseconds',
            'toDateString',
            'toTimeString',
            'toLocaleDateString',
            'toLocaleTimeString',
            'getTimezoneOffset',
        ].flatMap((name) => [
            { code: `date.${name}()`, filename: history, errors: [messageOf('local')] },
            { code: `date['${name}']()`, filename: history, errors: [messageOf('local')] },
            { code: 'date[`' + name + '`]()', filename: history, errors: [messageOf('local')] },
            { code: `const { ${name} } = date`, filename: history, errors: [messageOf('local')] },
        ]),
        { code: 'new Date()', filename: history, errors: [messageOf('construct')] },
        { code: 'new Date(2026, 9, 20)', filename: history, errors: [messageOf('construct')] },
        { code: "new Date('2026-10-20')", filename: history, errors: [messageOf('construct')] },
        { code: 'new Date(`2026-${m}-20`)', filename: history, errors: [messageOf('construct')] },
        { code: "Date.parse('2026-10-20')", filename: history, errors: [messageOf('parse')] },
        {
            code: "new Intl.DateTimeFormat('en')",
            filename: history,
            errors: [messageOf('intl')],
        },
        { code: 'const f = Intl.DateTimeFormat', filename: history, errors: [messageOf('intl')] },
        {
            code: 'const { DateTimeFormat } = Intl',
            filename: history,
            errors: [messageOf('intl')],
        },
        // Date.now() under src/editor/history, except calendarClock.ts.
        {
            code: 'const now = Date.now()',
            filename: `${root}/src/editor/history/PeekBar.vue`,
            errors: [messageOf('now')],
        },
        { code: 'const now = Date.now', filename: history, errors: [messageOf('now')] },
        // Date called as a function, destructured, or reached through the global object.
        { code: 'const text = Date()', filename: history, errors: [messageOf('call')] },
        { code: 'const text = globalThis.Date()', filename: history, errors: [messageOf('call')] },
        { code: 'const { now } = Date', filename: history, errors: [messageOf('now')] },
        { code: 'const { parse } = Date', filename: history, errors: [messageOf('parse')] },
        { code: 'const { now } = globalThis.Date', filename: history, errors: [messageOf('now')] },
        { code: 'globalThis.Date.now()', filename: history, errors: [messageOf('now')] },
        { code: 'window.Date.now()', filename: history, errors: [messageOf('now')] },
        { code: 'self.Date.parse(text)', filename: history, errors: [messageOf('parse')] },
        {
            code: 'new globalThis.Date(2026, 9, 20)',
            filename: history,
            errors: [messageOf('construct')],
        },
        { code: 'globalThis.Intl.DateTimeFormat', filename: history, errors: [messageOf('intl')] },
        {
            code: 'const at = Date["now"]()',
            filename: `${root}/src/editor/history/openHistory.ts`,
            errors: [messageOf('now')],
        },
    ],
})

ruleTester.run('local/history-imports', rules['history-imports']!, {
    valid: [
        { code: "import { historyFormat } from './historyFormat'", filename: history },
        { code: "import { dayKey, sameDay } from '../../calendar/calendar'", filename: history },
        {
            code: "import { createHistoryOperation } from '../../history/createHistoryOperation'",
            filename: history,
        },
        { code: "import { settings } from '../../settings'", filename: history },
        // switchRequest is not switch.
        { code: "import { x } from '../switchRequest'", filename: history },
        { code: "import { x } from '../../i18n/whenever'", filename: history },
        { code: "import('./historyFormat')", filename: history },
        { code: 'import(`./historyFormat`)', filename: history },
        { code: "export { dayKey } from '../../calendar/calendar'", filename: history },
        { code: "import { x } from 'when'", filename: history },
        { code: "import { x } from '@tauri-apps/api/core'", filename: history },
    ],
    invalid: [
        // Each banned module, by a static import, import() and a re-export.
        ...[
            ['../../i18n/when', 'src/i18n/when'],
            ['../../i18n/dateTime', 'src/i18n/dateTime'],
            ['../shownName', 'src/editor/shownName'],
            ['../labelText', 'src/editor/labelText'],
            ['../switch', 'src/editor/switch'],
            ['../loadNotices', 'src/editor/loadNotices'],
            ['../../i18n/when.ts', 'src/i18n/when'],
        ].flatMap(([source, module]) => {
            const errors = [{ messageId: 'module' as const, data: { module } }]
            return [
                { code: `import { x } from '${source}'`, filename: history, errors },
                { code: `import * as x from '${source}'`, filename: history, errors },
                { code: `import x from '${source}'`, filename: history, errors },
                { code: `import '${source}'`, filename: history, errors },
                { code: `const x = await import('${source}')`, filename: history, errors },
                { code: `export { x } from '${source}'`, filename: history, errors },
                { code: `export * from '${source}'`, filename: history, errors },
                { code: `export * as x from '${source}'`, filename: history, errors },
            ]
        }),
        // A template literal without holes names its module as a string does.
        {
            code: 'const x = await import(`../../i18n/when`)',
            filename: history,
            errors: [{ messageId: 'module' as const, data: { module: 'src/i18n/when' } }],
        },
        // Banned names from modules that otherwise may be used.
        ...['import', 'export'].flatMap((kind) => [
            {
                code: `${kind} { getHistoryOperationContext } from '../../history/createHistoryOperation'`,
                filename: history,
                errors: [
                    { messageId: 'name' as const, data: { name: 'getHistoryOperationContext' } },
                ],
            },
            {
                code: `${kind} { hostZone } from '../../calendar/calendar'`,
                filename: history,
                errors: [{ messageId: 'name' as const, data: { name: 'hostZone' } }],
            },
            {
                code: `${kind} { createHistoryOperation, getHistoryOperationContext as c } from '../../history/createHistoryOperation'`,
                filename: history,
                errors: [
                    { messageId: 'name' as const, data: { name: 'getHistoryOperationContext' } },
                ],
            },
        ]),
        {
            code: "import * as calendar from '../../calendar/calendar'",
            filename: history,
            errors: [{ messageId: 'name' as const, data: { name: 'hostZone' } }],
        },
        {
            code: "const calendar = await import('../../calendar/calendar')",
            filename: history,
            errors: [{ messageId: 'name' as const, data: { name: 'hostZone' } }],
        },
        {
            code: "export * from '../../history/createHistoryOperation'",
            filename: history,
            errors: [{ messageId: 'name' as const, data: { name: 'getHistoryOperationContext' } }],
        },
        // From a file in another folder of History, the same modules by their own relative path.
        {
            code: "import { formatDate } from '../../i18n/when'",
            filename: `${root}/src/history/operationPresentation/x.ts`,
            errors: [{ messageId: 'module' as const, data: { module: 'src/i18n/when' } }],
        },
        {
            code: "import { formatDate } from '../i18n/dateTime'",
            filename: `${root}/src/editor/peek.ts`,
            errors: [{ messageId: 'module' as const, data: { module: 'src/i18n/dateTime' } }],
        },
    ],
})

// A .vue file's template is read too.
const vueTester = new RuleTester({
    languageOptions: { parser: vueParser, ecmaVersion: 'latest', sourceType: 'module' },
})
const vueFile = `${root}/src/editor/history/TimelineList.vue`
const template = (expression: string) => `<template><p>{{ ${expression} }}</p></template>`
const script = (code: string) => `<script setup>
${code}
</script>`
vueTester.run('local/no-local-time in .vue', rules['no-local-time']!, {
    valid: [
        { code: template('format.clock(time)'), filename: vueFile },
        { code: template('new Date(time).getTime()'), filename: vueFile },
        { code: `${script('const a = 1')}${template('a')}`, filename: vueFile },
    ],
    invalid: [
        {
            code: template('new Date(1).getHours()'),
            filename: vueFile,
            errors: [messageOf('local')],
        },
        { code: template('Date.now()'), filename: vueFile, errors: [messageOf('now')] },
        {
            code: template('items.map((d) => d.toDateString())'),
            filename: vueFile,
            errors: [messageOf('local')],
        },
        {
            code: `<template><p :title="new Date(2026, 1).getDate()"></p></template>`,
            filename: vueFile,
            errors: [messageOf('local'), messageOf('construct')],
        },
        {
            code: `<template><p v-if="x">{{ y }}</p><p v-else>{{ Date.parse(s) }}</p></template>`,
            filename: vueFile,
            errors: [messageOf('parse')],
        },
        {
            code: `${script('const t = new Date(1).getMonth()')}${template('t')}`,
            filename: vueFile,
            errors: [messageOf('local')],
        },
    ],
})

// --- Through the real configuration

const eslint = new ESLint({ cwd: root })
const enabled = async (file: string, rule: string) => {
    const config = (await eslint.calculateConfigForFile(path.join(root, file))) as {
        rules?: Record<string, unknown>
    }
    const setting = config.rules?.[rule]
    const level = Array.isArray(setting) ? setting[0] : setting
    return level === 2 || level === 'error'
}

const filesUnder = (directory: string, extensions: string[]): string[] =>
    readdirSync(path.join(root, directory)).flatMap((name) => {
        const relative = `${directory}/${name}`
        return statSync(path.join(root, relative)).isDirectory()
            ? filesUnder(relative, extensions)
            : extensions.includes(path.extname(name))
              ? [relative]
              : []
    })

test("no-local-time covers all of History's files, with no allowlist", async () => {
    const files = [
        ...filesUnder('src/editor/history', ['.ts', '.vue']),
        ...filesUnder('src/history', ['.ts']),
        'src/editor/peek.ts',
        'src/local/worker/timelineHandlers.ts',
        'src/local/days.ts',
    ]
    assert.ok(files.length > 80)
    const off: string[] = []
    for (const file of files) if (!(await enabled(file, 'local/no-local-time'))) off.push(file)
    assert.deepEqual(off, [])
    // days.ts reads its date through the calendar module and is checked.
    assert.equal(await enabled('src/local/days.ts', 'local/no-local-time'), true)
    // The calendar module and the date formatter are where local time is read.
    assert.equal(await enabled('src/calendar/calendar.ts', 'local/no-local-time'), false)
    assert.equal(await enabled('src/i18n/dateTime.ts', 'local/no-local-time'), false)
    assert.equal(await enabled('src/editor/history/calendarClock.ts', 'local/no-local-time'), true)
})

test("history-imports covers History's files, apart from the four that bridge to the engine", async () => {
    const files = [
        ...filesUnder('src/editor/history', ['.ts', '.vue']),
        ...filesUnder('src/history', ['.ts']),
        'src/editor/peek.ts',
    ]
    const off: string[] = []
    for (const file of files) if (!(await enabled(file, 'local/history-imports'))) off.push(file)
    assert.deepEqual(off.sort(), [
        'src/editor/history/calendarClock.ts',
        'src/editor/history/historyFormat.ts',
        'src/history/createHistoryOperation.ts',
        'src/history/operationPresentation/format.ts',
    ])
})

test('the two History rules sit beside the native-code bans: one file importing both is flagged twice', async () => {
    // The one no-restricted-imports entry stays the only such object, so its bans still fire in
    // History files. (A second object would replace its options.)
    const config = (await eslint.calculateConfigForFile(
        path.join(root, 'src/editor/history/source.ts'),
    )) as {
        rules?: Record<string, unknown>
    }
    const restricted = config.rules?.['no-restricted-imports'] as unknown[]
    assert.ok(Array.isArray(restricted))
    assert.match(JSON.stringify(restricted), /@tauri-apps/)
    assert.match(JSON.stringify(restricted), /platform\/native/)

    // Only the two rules this test is about run, and the file needs no project.
    const lint = new ESLint({
        cwd: root,
        ruleFilter: ({ ruleId }) =>
            ruleId === 'no-restricted-imports' || ruleId.startsWith('local/'),
        overrideConfig: [
            {
                files: ['**/*.ts'],
                languageOptions: { parserOptions: { projectService: false } },
            },
        ],
    })
    const code = [
        "import { invoke } from '@tauri-apps/api/core'",
        "import { formatDate } from '../../i18n/when'",
        "import { dayKey } from '../../calendar/calendar'",
        'export const x = [invoke, formatDate, dayKey, new Date(1).getHours()]',
        '',
    ].join('\n')
    const [result] = await lint.lintText(code, {
        filePath: path.join(root, 'src/editor/history/zzzProbe.ts'),
    })
    const found = result!.messages.map((message) => [message.ruleId, message.line])
    assert.deepEqual(found.sort(), [
        ['local/history-imports', 2],
        ['local/no-local-time', 4],
        ['no-restricted-imports', 1],
    ])
})

test('through the real configuration a History .vue file is checked in its template and its script', async () => {
    const lint = new ESLint({
        cwd: root,
        ruleFilter: ({ ruleId }) =>
            ruleId === 'no-restricted-imports' || ruleId.startsWith('local/'),
        overrideConfig: [
            {
                files: ['**/*.ts', '**/*.vue'],
                languageOptions: { parserOptions: { projectService: false } },
            },
        ],
    })
    const code = [
        '<script setup lang="ts">',
        "import { formatDate } from '../../i18n/when'",
        'const shown = formatDate(1)',
        '</script>',
        '<template>',
        '    <p>{{ shown }} {{ new Date(1).getHours() }}</p>',
        '</template>',
        '',
    ].join('\n')
    const [result] = await lint.lintText(code, {
        filePath: path.join(root, 'src/editor/history/ZzProbe.vue'),
    })
    assert.deepEqual(result!.messages.map((message) => [message.ruleId, message.line]).sort(), [
        ['local/history-imports', 2],
        ['local/no-local-time', 6],
    ])
})
