import { ESLint, RuleTester, type Rule } from 'eslint'
import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it, test } from 'node:test'
import { parser as tsParser } from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'
import local from '../../../scripts/eslint-plugin-local.mjs'

// `local/no-use-day-cast` (I-11): a `UseDay` is made by `countDayOfUse`, `NO_USE_DAY` and the row
// types only. The rule works by name; the real eslint.config.js is asked where it applies.

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const root = path.resolve(import.meta.dirname, '../../..')
const file = `${root}/src/local/putChunk.ts`
const rules = local.rules as unknown as Record<string, Rule.RuleModule>
const rule = rules['no-use-day-cast']!
const cast = { messageId: 'cast' }

new RuleTester({
    languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' },
}).run('local/no-use-day-cast', rule, {
    valid: [
        { code: 'const day: UseDay = countDayOfUse(tx, now)', filename: file },
        { code: 'const n = value as number', filename: file },
        { code: 'const k = time as DayKey', filename: file },
        { code: 'const d = storedDay(old, fallback)', filename: file },
        { code: 'const n = x as Other<UseDay>', filename: file },
    ],
    invalid: [
        { code: 'const d = value as UseDay', filename: file, errors: [cast] },
        { code: 'const d = (n + 1) as UseDay', filename: file, errors: [cast] },
        { code: 'const d = value as unknown as UseDay', filename: file, errors: [cast] },
        { code: 'const d = <UseDay>value', filename: file, errors: [cast] },
        { code: 'const d = value as UseDay | undefined', filename: file, errors: [cast] },
        { code: 'const d = value as number & UseDay', filename: file, errors: [cast] },
    ],
})

new RuleTester({
    languageOptions: {
        parser: vueParser,
        parserOptions: { parser: tsParser },
        ecmaVersion: 'latest',
        sourceType: 'module',
    },
}).run('local/no-use-day-cast in .vue', rule, {
    valid: [
        {
            code: '<script setup lang="ts">const a = 1</script><template><p>{{ a }}</p></template>',
            filename: `${root}/src/editor/Zz.vue`,
        },
    ],
    invalid: [
        {
            code: '<script setup lang="ts">const a = 1 as UseDay</script><template><p>{{ a }}</p></template>',
            filename: `${root}/src/editor/Zz.vue`,
            errors: [cast],
        },
    ],
})

const eslint = new ESLint({ cwd: root })
const enabled = async (name: string) => {
    const config = (await eslint.calculateConfigForFile(path.join(root, name))) as {
        rules?: Record<string, unknown>
    }
    const setting = config.rules?.['local/no-use-day-cast']
    const level = Array.isArray(setting) ? setting[0] : setting
    return level === 2 || level === 'error'
}

test('the cast ban covers src, apart from days.ts and records/rows.ts', async () => {
    assert.equal(await enabled('src/local/days.ts'), false)
    assert.equal(await enabled('src/local/records/rows.ts'), false)
    for (const name of [
        'src/local/putChunk.ts',
        'src/local/save/repair.ts',
        'src/local/open/importWrite.ts',
        'src/local/db.ts',
        'src/editor/history/source.ts',
        'src/editor/history/GoToList.vue',
    ])
        assert.equal(await enabled(name), true, name)
})

test('through the real configuration a cast in src is reported and days.ts may make one', async () => {
    const lint = new ESLint({
        cwd: root,
        ruleFilter: ({ ruleId }) => ruleId === 'local/no-use-day-cast',
        overrideConfig: [
            { files: ['**/*.ts'], languageOptions: { parserOptions: { projectService: false } } },
        ],
    })
    const code = 'export const d = 5 as UseDay\n'
    const [other] = await lint.lintText(code, { filePath: path.join(root, 'src/local/zzProbe.ts') })
    assert.deepEqual(
        other!.messages.map((message) => [message.ruleId, message.line]),
        [['local/no-use-day-cast', 1]],
    )
    const [days] = await lint.lintText(code, { filePath: path.join(root, 'src/local/days.ts') })
    assert.deepEqual(days!.messages, [])
})
