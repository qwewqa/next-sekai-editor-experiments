import { ESLint, RuleTester, type Rule } from 'eslint'
import assert from 'node:assert/strict'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it, test } from 'node:test'
import local from '../../../scripts/eslint-plugin-local.mjs'

// `local/stored-reads` (Part 1 §1.6.5): the storage worker's covered reads are called only through
// the `storedRead` gate. The rule reports a covered method named by a string literal in a `.call(`
// anywhere else in `src`; an alias, a computed name and an uncovered read are checked by review.

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const root = path.resolve(import.meta.dirname, '../../..')
const rule = (local.rules as unknown as Record<string, Rule.RuleModule>)['stored-reads']!
const ruleTester = new RuleTester({
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
})
const gate = { messageId: 'gate' }

ruleTester.run('local/stored-reads', rule, {
    valid: [
        // Inside the gate itself.
        {
            code: "worker.call('readHandle', arg)",
            filename: `${root}/src/local/storedRead.ts`,
        },
        // An uncovered read and a write.
        { code: "worker.call('readSession', id)", filename: `${root}/src/local/open/project.ts` },
        { code: "worker.call('flush', batch)", filename: `${root}/src/local/storing.ts` },
        // Other `call`s.
        { code: "fn.call(this, 'readHandle')", filename: `${root}/src/local/handles.ts` },
        { code: "query.call('readHandle'.length)", filename: `${root}/src/local/handles.ts` },
        { code: 'worker.call()', filename: `${root}/src/local/handles.ts` },
        // The gate itself, and a name that is not written out (a residual: checked by review).
        {
            code: "storedRead(worker, 'readHandle', arg)",
            filename: `${root}/src/local/handles.ts`,
        },
        { code: 'worker.call(method, arg)', filename: `${root}/src/local/handles.ts` },
        {
            code: "const read = worker.call; read('readHandle')",
            filename: `${root}/src/local/x.ts`,
        },
    ],
    invalid: [
        ...[
            'readHandle',
            'listHandleOwners',
            'readBindings',
            'readChainRecord',
            'replaceDecision',
            'openEarlierChains',
            'openPendingImports',
            'openImportTarget',
            'listRecovered',
            'readRecovered',
            'listKept',
            'findEdits',
        ].map((method) => ({
            code: `await worker.call('${method}', arg)`,
            filename: `${root}/src/local/open/project.ts`,
            errors: [gate],
        })),
        // Through a deeper receiver, with a catch, a template literal and a computed `call`.
        {
            code: "await open.worker.call('readChainRecord', id).catch(() => undefined)",
            filename: `${root}/src/editor/save/env.ts`,
            errors: [gate],
        },
        {
            code: 'await worker.call(`listHandleOwners`)',
            filename: `${root}/src/editor/save/env.ts`,
            errors: [gate],
        },
        {
            code: "await worker['call']('readHandle', arg)",
            filename: `${root}/src/editor/save/env.ts`,
            errors: [gate],
        },
    ],
})

// --- Through the real configuration

const eslint = new ESLint({ cwd: root })
const enabled = async (file: string) => {
    const config = (await eslint.calculateConfigForFile(path.join(root, file))) as {
        rules?: Record<string, unknown>
    }
    const setting = config.rules?.['local/stored-reads']
    const level = Array.isArray(setting) ? setting[0] : setting
    return level === 2 || level === 'error'
}

const filesUnder = (directory: string): string[] =>
    readdirSync(path.join(root, directory)).flatMap((name) => {
        const relative = `${directory}/${name}`
        return statSync(path.join(root, relative)).isDirectory()
            ? filesUnder(relative)
            : ['.ts', '.vue'].includes(path.extname(name))
              ? [relative]
              : []
    })

test('stored-reads covers every file of src', async () => {
    const files = filesUnder('src')
    assert.ok(files.length > 300)
    const off: string[] = []
    for (const file of files) if (!(await enabled(file))) off.push(file)
    assert.deepEqual(off, [])
})

test('through the real configuration, a covered read outside the gate is reported', async () => {
    const lint = new ESLint({
        cwd: root,
        ruleFilter: ({ ruleId }) => ruleId.startsWith('local/'),
        overrideConfig: [
            { files: ['**/*.ts'], languageOptions: { parserOptions: { projectService: false } } },
        ],
    })
    const code = "export const read = (worker) => worker.call('readHandle', { role: 'file' })\n"
    const [other] = await lint.lintText(code, {
        filePath: path.join(root, 'src/local/zzProbe.ts'),
    })
    assert.deepEqual(
        other!.messages.map((message) => [message.ruleId, message.line]),
        [['local/stored-reads', 1]],
    )
    const [gated] = await lint.lintText(code, {
        filePath: path.join(root, 'src/local/storedRead.ts'),
    })
    assert.deepEqual(gated!.messages, [])
})
