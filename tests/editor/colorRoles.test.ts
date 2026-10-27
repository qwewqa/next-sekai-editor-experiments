// The colour-role guard (docs/color-system.md, "The guard test"). It scans src for the uses the
// control recipes replace: mint on a press or outside the recipes, focus colours and removed focus
// rings set by hand, the hover glow, the destructive fill, raw palette colours and colour literals.
// Chart content is exempt; the few allowed uses of mint carry their reasons.
//
// Transition: each colour package lists the files it still has to migrate in
// tests/editor/colorRoles/legacy-C<n>.txt (C8 is split per History package: legacy-C8-H<n>.txt), and
// deletes its list as its last commit. A listed file that is already clean fails the test, so stale
// entries cannot linger. Once every package has migrated, the folder is gone and no file is exempt.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const src = join(root, 'src')
const legacyDirectory = join(root, 'tests', 'editor', 'colorRoles')

/** Files that define the roles. */
const definitions = ['src/themes.css', 'src/controls.css']

/** Chart content: its colours name chart objects, not UI roles (docs/color-system.md, "Out of scope"). */
const chart: [RegExp, string][] = [
    [/^src\/editor\/canvas\//, 'chart drawing'],
    [/^src\/editor\/minimap\/paint\.ts$/, 'minimap chart drawing'],
    [/^src\/editor\/elevation\/(?!ElevationEditor\.vue)/, 'elevation canvas drawing'],
    [/^src\/preview\/(render|usePreviewRendering)/, 'preview renderer and its overlay'],
    [/^src\/utils\/colors\.ts$/, 'note style colours'],
    [/^src\/modals\/form\/NoteShapeIcon\.vue$/, 'note artwork'],
    [
        /^src\/editor\/commands\/(bpm|timeScale)\.ts$/,
        "chips that match the chart's BPM and time-scale colours",
    ],
]

/** Allowed uses of mint outside the recipes: file, a pattern the line must match, and why. */
const allowed: [string, RegExp, string][] = [
    [
        'src/editor/QuickNotice.vue',
        /colors\.(on-)?accent/,
        'the quick notice: mint for every quick notice',
    ],
    [
        'src/editor/workspace/PanelRail.vue',
        /panel-tab-marker\b.*\bbg-accent(?![\w-])/,
        'the rail marker on the dark chrome: current',
    ],
    ['src/editor/history/PeekBar.vue', /ring-accent/, 'the peek ring: a mode in force'],
    [
        'src/preview/PreviewSettings.vue',
        /shadow-accent/,
        'range thumbs take the hover glow and cannot take a class',
    ],
]

const utilityToken =
    /(?<![\w\-[])((?:[\w\-[\]@():&_.>=',%]+:)*)(!?)(-?(?:bg|text|fill|stroke|ring|outline|border|shadow|from|to|via|decoration|caret)-[\w\-/[\]#().%]+)(?![\w-])/g
const colourProperty = '(?:bg|text|fill|stroke|ring|outline|border|shadow|from|to|via|decoration)'
const mint = new RegExp(
    `^${colourProperty}-(?:accent|accent-press|accent-strong|selected)(?:/\\d+)?$`,
)
/** Ink on mint, on any property: under a press it is a leftover of the mint press. */
const onAccent = new RegExp(`^${colourProperty}-on-accent(?:/\\d+)?$`)
const pressVariant =
    /(?:^|:)(?:active|group-active|peer-active|has-\[:active\]|enabled:active)(?=:|$)|\[\.popup-item:enabled:active_&\]/
const focusVariant =
    /(?:^|:)(?:focus|focus-visible|focus-within|group-focus-visible|peer-focus-visible)(?=:|$)/
const palette = new RegExp(
    `^${colourProperty}-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}(?:/\\d+)?$`,
)
const literal = new RegExp(`^${colourProperty}-\\[(?:#|rgb|hsl|color:#)`)

type Rule =
    | 'press-is-mint'
    | 'mint-outside-recipes'
    | 'hover-glow-outside-recipes'
    | 'focus-colour'
    | 'focus-outline-none'
    | 'danger-fill-outside-recipes'
    | 'raw-palette'
    | 'colour-literal'

/** The rules one line of text breaks, one entry per offending token. */
const detect = (content: string): Rule[] => {
    const out: Rule[] = []
    for (const match of content.matchAll(utilityToken)) {
        const variants = match[1] ?? ''
        const utility = match[3] ?? ''
        if (utility === 'shadow-accent') out.push('hover-glow-outside-recipes')
        // The recipe ring sits in the components layer. A leftover outline-none (same specificity,
        // later layer) silently removes it, and visible focus is the function that must not be lost.
        else if (focusVariant.test(variants) && utility === 'outline-none')
            out.push('focus-outline-none')
        else if (mint.test(utility))
            out.push(
                pressVariant.test(variants)
                    ? 'press-is-mint'
                    : focusVariant.test(variants)
                      ? 'focus-colour'
                      : 'mint-outside-recipes',
            )
        else if (pressVariant.test(variants) && onAccent.test(utility)) out.push('press-is-mint')
        else if (
            focusVariant.test(variants) &&
            /^(?:ring|outline)-(?:fg|white|current|on-accent)(?:\/\d+)?$/.test(utility)
        )
            out.push('focus-colour')
        else if (/^bg-danger(?:\/\d+)?$/.test(utility)) out.push('danger-fill-outside-recipes')
        else if (palette.test(utility)) out.push('raw-palette')
        else if (literal.test(utility)) out.push('colour-literal')
    }
    if (
        /theme\(\s*['"]?colors\.(?:(?:on-)?accent|selected)\b|var\(--color-(?:(?:on-)?accent|selected)\b/.test(
            content,
        )
    )
        out.push('mint-outside-recipes')
    return out
}

const stripComments = (text: string) =>
    text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(
            /(^|[^:'"`])\/\/[^\n]*/g,
            (m, before: string) => before + ' '.repeat(m.length - before.length),
        )

type CssRule = { selector: string; body: string; bodyStart: number }

/** CSS rules (in .css and in .vue <style>), with a nested @media flattened. */
const cssRules = (text: string): CssRule[] => {
    const out: CssRule[] = []
    for (const match of text.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
        const selector = (match[1] ?? '').trim()
        if (selector.startsWith('@')) continue
        out.push({
            selector,
            body: match[2] ?? '',
            bodyStart: match.index + (match[1] ?? '').length + 1,
        })
    }
    return out
}

type Finding = { file: string; line: number; rule: string; text: string }

const sourceFiles = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
        const path = join(directory, name)
        if (statSync(path).isDirectory()) return sourceFiles(path)
        return /\.(vue|ts|css)$/.test(name) ? [path] : []
    })

const scan = (): { findings: Finding[]; files: number } => {
    const findings: Finding[] = []
    const files = sourceFiles(src)
    for (const path of files) {
        const file = relative(root, path).replaceAll('\\', '/')
        if (definitions.includes(file) || chart.some(([pattern]) => pattern.test(file))) continue
        const text = stripComments(readFileSync(path, 'utf8'))
        const add = (line: number, rule: string, content: string) =>
            findings.push({ file, line, rule, text: content.trim().slice(0, 140) })
        text.split('\n').forEach((content, index) => {
            for (const rule of detect(content)) add(index + 1, rule, content)
        })
        // CSS rules whose selector is a press or focus state and whose body uses the mint.
        if (!/\.(css|vue)$/.test(file)) continue
        for (const rule of cssRules(text)) {
            const usesMint =
                /(?:^|\s|-)(?:bg|text|fill|ring|shadow)-(?:accent|on-accent)\b|colors\.(?:on-)?accent|--color-(?:on-)?accent/.test(
                    rule.body,
                )
            if (!usesMint) continue
            const line = text.slice(0, rule.bodyStart).split('\n').length
            const pressed = /:active|is-held|is-pressed|-pressed\b/.test(
                rule.selector.replace(/:not\(:active\)/g, ''),
            )
            if (pressed) add(line, 'press-is-mint (css rule)', `${rule.selector} { … }`)
            if (/:focus/.test(rule.selector))
                add(line, 'focus-colour (css rule)', `${rule.selector} { … }`)
        }
    }
    return { findings, files: files.length }
}

const isAllowed = (finding: Finding) =>
    allowed.some(
        ([file, pattern]) =>
            finding.file === file &&
            pattern.test(finding.text) &&
            (finding.rule === 'mint-outside-recipes' ||
                finding.rule === 'hover-glow-outside-recipes'),
    )

/** The legacy lists: list name to the files its package has not migrated yet. */
const legacyLists = () =>
    new Map(
        (existsSync(legacyDirectory) ? readdirSync(legacyDirectory) : [])
            .filter((name) => /^legacy-C\d+(-H\d+)?\.txt$/.test(name))
            .sort()
            .map((name): [string, string[]] => [
                name,
                readFileSync(join(legacyDirectory, name), 'utf8')
                    .split('\n')
                    .map((line) => line.replace(/#.*/, '').trim())
                    .filter(Boolean),
            ]),
    )

test('the detector catches every form the recipes replace', () => {
    const hit: [string, Rule][] = [
        ['class="bg-accent text-on-accent"', 'mint-outside-recipes'],
        ['class="active:bg-accent"', 'press-is-mint'],
        ['class="group-active:bg-accent"', 'press-is-mint'],
        ['class="peer-active:text-on-accent"', 'press-is-mint'],
        ['class="has-[:active]:bg-accent"', 'press-is-mint'],
        ['class="!bg-accent"', 'mint-outside-recipes'],
        ['@apply bg-accent text-on-accent', 'mint-outside-recipes'],
        ["color: theme('colors.accent')", 'mint-outside-recipes'],
        ['class="hover:shadow-accent"', 'hover-glow-outside-recipes'],
        ['class="focus-visible:ring-white"', 'focus-colour'],
        ['class="focus-visible:outline-fg"', 'focus-colour'],
        ['class="focus-visible:outline-none"', 'focus-outline-none'],
        ['class="focus:outline-none"', 'focus-outline-none'],
        ['@apply focus-visible:outline-none', 'focus-outline-none'],
        ['class="group-active:bg-on-accent/30"', 'press-is-mint'],
        ['class="active:border-on-accent"', 'press-is-mint'],
        ['class="active:ring-on-accent"', 'press-is-mint'],
        ['class="text-amber-300"', 'raw-palette'],
        ['class="bg-[#fff]"', 'colour-literal'],
    ]
    for (const [snippet, rule] of hit)
        assert.ok(detect(snippet).includes(rule), `should flag ${rule}: ${snippet}`)
})

test('the detector passes the recipes and the role tokens', () => {
    const pass = [
        'class="btn btn-secondary"',
        'class="btn btn-primary focus-out"',
        'class="ghost ghost-band btn-toggle"',
        'class="row-checked row-current focus-edge"',
        'class="row-select relative flex has-[:disabled]:opacity-40"',
        'class="text-danger bg-danger-fill text-on-danger"',
        'class="bg-ghost-press text-fg-strong"',
        'class="active:bg-ghost-press"',
        'class="focus-visible:outline-offset-2"',
        '@apply bg-press text-fg-strong',
        'class="text-warning text-info"',
        'class="outline-none"',
        'class="bg-on-accent"',
    ]
    for (const snippet of pass) assert.deepEqual(detect(snippet), [], snippet)
})

test('the legacy lists name only files that still break a rule, each once', () => {
    const { findings } = scan()
    const violating = new Set(findings.filter((f) => !isAllowed(f)).map((f) => f.file))
    const owner = new Map<string, string>()
    for (const [list, files] of legacyLists())
        for (const file of files) {
            assert.ok(!owner.has(file), `${file} is in ${owner.get(file)} and ${list}`)
            owner.set(file, list)
            assert.ok(
                statSync(join(root, file), { throwIfNoEntry: false }),
                `${list}: ${file} does not exist`,
            )
            assert.ok(violating.has(file), `${list}: ${file} is already clean; delete the entry`)
        }
})

test('no file outside the legacy lists breaks a colour rule', () => {
    const { findings, files } = scan()
    assert.ok(files > 500, 'the scan found the source tree')
    const listed = new Set([...legacyLists().values()].flat())
    const violations = findings.filter((f) => !isAllowed(f) && !listed.has(f.file))
    assert.deepEqual(
        violations.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.text}`),
        [],
        'use the recipes in src/controls.css and the role tokens (docs/color-system.md)',
    )
})

test('every allowed use of mint still occurs, so no entry outlives its code', () => {
    const { findings } = scan()
    for (const [file, pattern] of allowed)
        assert.ok(
            findings.some((f) => f.file === file && pattern.test(f.text) && isAllowed(f)),
            `${file}: ${pattern} is allowed but not used`,
        )
})
