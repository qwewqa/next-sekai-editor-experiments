import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { languageTag, pluralForm } from '../../src/i18n/plural'

type Localization = { [key: string]: string | Localization }
const directory = new URL('../../src/i18n/', import.meta.url)
const flatten = (localization: Localization, prefix = ''): Record<string, string> =>
    Object.fromEntries(
        Object.entries(localization).flatMap(([key, value]) => {
            const path = prefix ? `${prefix}.${key}` : key
            return typeof value === 'string'
                ? [[path, value]]
                : Object.entries(flatten(value, path))
        }),
    )
const read = (locale: string) =>
    flatten(
        JSON.parse(
            readFileSync(new URL(`${locale}/index.json`, directory), 'utf8'),
        ) as Localization,
    )
const english = read('en')
const placeholders = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort()
// Singular and plural forms, as "{0} object|{0} objects", each hold every placeholder.
const forms = (text: string) => text.split('|')

test('English messages have at most a singular and a plural form', () => {
    for (const [key, text] of Object.entries(english)) {
        assert.ok(forms(text).length <= 2, key)
        for (const form of forms(text))
            assert.deepEqual(placeholders(form), placeholders(forms(text)[0]!), key)
    }
})

for (const locale of readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'en')
    .map((entry) => entry.name)) {
    test(`${locale} includes every English message and preserves interpolation placeholders`, () => {
        const translated = read(locale)
        assert.deepEqual(Object.keys(translated).sort(), Object.keys(english).sort())
        for (const [key, text] of Object.entries(translated)) {
            assert.ok(text.trim(), `${locale}.${key}: empty translation`)
            assert.ok(
                !/\uFFFD|\?{2,}|\p{L}\?\p{L}/u.test(text),
                `${locale}.${key}: damaged Unicode`,
            )
            assert.ok(forms(text).length <= 2, `${locale}.${key}: too many forms`)
            for (const form of forms(text))
                assert.deepEqual(
                    placeholders(form),
                    placeholders(forms(english[key]!)[0]!),
                    `${locale}.${key}`,
                )
        }
    })
}

test('plural forms follow each locale’s rules', () => {
    const message = '{0} object|{0} objects'
    assert.equal(pluralForm('en', message, '1'), '{0} object')
    assert.equal(pluralForm('en', message, '0'), '{0} objects')
    assert.equal(pluralForm('en', message, '2'), '{0} objects')
    // French counts zero as singular.
    assert.equal(pluralForm('fr', message, '0'), '{0} object')
    assert.equal(pluralForm('fr', message, '2'), '{0} objects')
    // Chinese has one form; locale codes map to language tags.
    assert.equal(pluralForm('zhs', message, '1'), '{0} objects')
    assert.equal(pluralForm('en', 'Saved', '1'), 'Saved')
})

test('every locale has a language tag that names its script', () => {
    const scripts: Record<string, string> = {
        en: 'Latn',
        fr: 'Latn',
        ja: 'Jpan',
        ko: 'Kore',
        tr: 'Latn',
        zhs: 'Hans',
        zht: 'Hant',
    }
    for (const locale of readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)) {
        // An unknown code such as "zht" maximizes to no script, so Chinese fonts fall back.
        assert.equal(
            new Intl.Locale(languageTag(locale)).maximize().script,
            scripts[locale],
            locale,
        )
    }
})

test('status bar scope names start with a capital where the script has case', () => {
    for (const locale of readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)) {
        const messages = read(locale)
        for (const key of [
            'statusBar.group.all',
            'statusBar.group.one',
            'statusBar.stage.all',
            'statusBar.stage.one',
        ]) {
            // A leading placeholder is the name itself, as in Turkish "{0} grubu".
            const first = messages[key]!.charAt(0)
            assert.equal(first, first.toLocaleUpperCase(locale), `${locale} ${key}`)
        }
    }
})

test('group and stage names stand apart from the noun after them', () => {
    for (const locale of ['ja', 'ko', 'zhs', 'zht']) {
        const messages = read(locale)
        for (const key of ['statusBar.group.one', 'statusBar.stage.one']) {
            // Names such as "Verse" or Korean "기본" (Default) don't run into the noun or take 번 ("number").
            assert.match(messages[key]!, /^\{0\} \S/, `${locale} ${key}`)
            assert.doesNotMatch(messages[key]!, /번/, `${locale} ${key}`)
        }
    }
    for (const [key, text] of Object.entries(read('ko')))
        assert.doesNotMatch(text, /\{\d+\}번/, `ko ${key}`)
})

test('both flip commands name their axis', () => {
    for (const locale of readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)) {
        const messages = read(locale)
        // As French "Retourner" beside "Retourner verticalement" did not.
        const horizontal = messages['commands.flip.title']!
        const vertical = messages['commands.flipVertical.title']!
        assert.ok(!vertical.startsWith(horizontal) && !horizontal.startsWith(vertical), locale)
    }
})

test('division commands are named as their dialog is, as lane division commands are', () => {
    for (const locale of readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)) {
        const messages = read(locale)
        // Not French "Passer à la division personnalisée" beside "Division personnalisée".
        for (const axis of ['divisions', 'laneDivisions'])
            assert.equal(
                messages[`commands.${axis}.custom.title`],
                messages[`commands.${axis}.custom.modal.title`],
                `${locale} ${axis}`,
            )
        // A noun with the fraction, not "Passer à la division en 1/4".
        const title = messages['commands.divisions.title']!
        assert.ok(title.replace('1/{0}', '').trim().split(/\s+/).length <= 2, locale)
    }
})

test('unit labels follow their locale’s pattern', () => {
    const unit = '\\((?:초|밀리초|비트|레인|%|秒|毫秒|拍|ミリ秒)\\)'
    // Japanese and Korean put a space before the parenthesis.
    for (const locale of ['ja', 'ko'])
        for (const [key, text] of Object.entries(read(locale)))
            assert.doesNotMatch(text, new RegExp(`[^\\s]${unit}`), `${locale} ${key}`)
    // Chinese uses full-width parentheses.
    for (const locale of ['zhs', 'zht'])
        for (const [key, text] of Object.entries(read(locale)))
            assert.doesNotMatch(text, new RegExp(unit), `${locale} ${key}`)
})

test('the Japanese capture tooltip says what its prompt says', () => {
    const messages = read('ja')
    // As the prompt "キーを押すか、もう一度クリックして削除", not a longer sentence.
    assert.ok(messages['modals.form.key.press']!.includes('もう一度クリックして削除'))
    assert.match(messages['modals.form.key.clear']!, /^もう一度クリックして\S*削除$/)
})

test('Japanese writes すべて, never 全て', () => {
    for (const [key, text] of Object.entries(read('ja'))) assert.doesNotMatch(text, /全て/, key)
})

test('Japanese writes ペースト, as the command, never 貼り付け', () => {
    for (const [key, text] of Object.entries(read('ja'))) assert.doesNotMatch(text, /貼り付/, key)
})

test('Japanese units take half-width parentheses', () => {
    for (const [key, text] of Object.entries(read('ja')))
        assert.doesNotMatch(text, /（[^{}）]*）$/, key)
})

test('Turkish editor names all use Editör', () => {
    for (const [key, text] of Object.entries(read('tr')))
        assert.doesNotMatch(text, /[Dd]üzenleyici/, key)
})

test('Turkish writes the beats unit one way, lower case as its other units', () => {
    for (const [key, text] of Object.entries(read('tr')))
        for (const [unit] of text.matchAll(/\(vuruş\w*\)/giu)) assert.equal(unit, '(vuruş)', key)
})

test('Korean show settings all end in 표시', () => {
    for (const [key, text] of Object.entries(read('ko')))
        if (/^settings\.editor\.show/.test(key)) assert.match(text, /표시$/, key)
})

test('English uses curly apostrophes', () => {
    for (const [key, text] of Object.entries(english)) assert.doesNotMatch(text, /'/, key)
})

test('French text uses one typographic style', () => {
    for (const [key, text] of Object.entries(read('fr'))) {
        assert.doesNotMatch(text, /'/, `fr ${key}: curly apostrophes, as most of fr`)
        // A no-break space before ? ! ; (narrow) and : %, so the mark never wraps alone; "(%)" is a unit.
        // A colon between digits is a ratio such as 1:1, which takes none.
        assert.doesNotMatch(
            text,
            /[^\u202f][?!;]|[^\u00a0(]%|[^\u00a0(](?:(?<!\d):|:(?!\d))/,
            `fr ${key}`,
        )
    }
})

test('Preview Editor units stay on the line of the word before them', () => {
    for (const locale of readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name))
        for (const [key, text] of Object.entries(read(locale)))
            // As fr "Durée du fondu de sortie (s)", which left "(s)" alone at 390.
            if (key.startsWith('utilities.previewEditor.'))
                assert.doesNotMatch(text, / [(（]/, `${locale} ${key}`)
})

// Values that read the same as English on purpose: names, symbols, "BGM" and the like. Seeded from the
// values identical when this test was added; a new entry needs a reason.
const identicalToEnglish: Record<string, string[]> = {
    fr: [
        'commands.bpm.title',
        'commands.divisions.custom.modal.division',
        'commands.events.title',
        'commands.laneDivisions.custom.modal.division',
        'commands.note.title.default',
        // French writes "skin", as in its preview strings.
        'commands.previewAssets.noun.skin',
        'commands.previewAssets.skin',
        'commands.slide.title.default',
        'commands.visibilities.toggle.types.bpm',
        'commands.visibilities.toggle.types.note',
        // The device, the time and the count in one line.
        'conflict.saved',
        'conflict.savedNoNotes',
        'elevation.auto',
        // A file name, as Sonolus servers name level data.
        'export.placeholder',
        // These French labels have the same spelling as English.
        'history.details.counts.note',
        'history.quoted',
        'history.quotedField',
        'historyChanges.fields.description',
        'historyChanges.fields.tags',
        'historyChanges.fields.type',
        // French spells "Version" the same.
        'load.version',
        'modals.form.bpm.label',
        'modals.form.cameraRotation.label',
        'modals.form.cameraZoom.label',
        'modals.form.colors.cyan',
        'modals.form.connectorType.active',
        'modals.form.connectorType.guide',
        'modals.form.connectorType.label',
        'modals.form.judgmentLineColor.cyan',
        'modals.form.key.names.alt',
        'modals.form.key.names.ctrl',
        'modals.form.key.names.tab',
        'modals.form.listJoin',
        'modals.form.noteType.trace',
        'modals.form.rotation.label',
        'modals.form.sentenceJoin',
        'modals.form.sfx.normalFlick',
        'modals.form.sfx.normalTap',
        'modals.form.sfx.normalTick',
        'modals.form.sfx.normalTrace',
        'modals.form.timeScaleTransition.label',
        'modals.form.unset.auto',
        'modals.info.ok',
        // French spells "note" the same.
        'peek.notes',
        // French spells "Version" the same.
        'settings.about.version',
        'settings.editor.waveformVisualization.fft',
        'settings.editor.waveformVisualization.volume',
        'settings.preview.controls.auto',
        'settings.preview.position.auto',
        'settings.preview.position.title',
        'settings.preview.transport.auto',
        'sidebars.view.division',
        'tools.bpm.title',
        'tools.brush.kinds.note',
        'workspace.folders.path',
        'workspace.manager.copyName',
        'workspace.properties.kinds.bpm',
        'workspace.properties.kinds.note',
    ],
    ja: [
        'commands.bgm.title',
        'commands.bpm.title',
        'commands.events.title',
        'commands.toggleVolume.type.bgm',
        'commands.visibilities.toggle.types.bpm',
        // A file name, as Sonolus servers name level data.
        'export.placeholder',
        'modals.form.bpm.label',
        'modals.form.key.names.alt',
        'modals.form.key.names.backspace',
        'modals.form.key.names.ctrl',
        'modals.form.key.names.delete',
        'modals.form.key.names.end',
        'modals.form.key.names.enter',
        'modals.form.key.names.escape',
        'modals.form.key.names.home',
        'modals.form.key.names.insert',
        'modals.form.key.names.pageDown',
        'modals.form.key.names.pageUp',
        'modals.form.key.names.shift',
        'modals.form.key.names.space',
        'modals.form.key.names.tab',
        'modals.info.ok',
        // "BGM" as in its other BGM strings.
        'open.media.bgm',
        // "BGM", as in its other strings.
        'save.bgm',
        'settings.editor.waveformVisualization.fft',
        'tools.bpm.title',
        'utilities.previewEditor.bgm',
        'workspace.folders.path',
        'workspace.manager.copyName',
        'workspace.properties.kinds.bpm',
    ],
    ko: [
        'commands.bpm.title',
        'commands.events.title',
        'commands.visibilities.toggle.types.bpm',
        // The device, the time and the count in one line.
        'conflict.saved',
        'conflict.savedNoNotes',
        // A file name, as Sonolus servers name level data.
        'export.placeholder',
        'history.quoted',
        'history.quotedField',
        'modals.form.bpm.label',
        'modals.form.key.names.alt',
        'modals.form.key.names.backspace',
        'modals.form.key.names.ctrl',
        'modals.form.key.names.delete',
        'modals.form.key.names.end',
        'modals.form.key.names.enter',
        'modals.form.key.names.escape',
        'modals.form.key.names.home',
        'modals.form.key.names.insert',
        'modals.form.key.names.pageDown',
        'modals.form.key.names.pageUp',
        'modals.form.key.names.shift',
        'modals.form.key.names.space',
        'modals.form.key.names.tab',
        'modals.form.listJoin',
        'modals.form.sentenceJoin',
        // "BGM" as in its other BGM strings.
        // "BGM", as in its other strings.
        'settings.editor.waveformVisualization.fft',
        'tools.bpm.title',
        'workspace.folders.path',
        'workspace.manager.copyName',
        'workspace.properties.kinds.bpm',
    ],
    tr: [
        'commands.bpm.title',
        'commands.events.title',
        'commands.visibilities.toggle.types.bpm',
        // The device, the time and the count in one line.
        'conflict.saved',
        'conflict.savedNoNotes',
        // A file name, as Sonolus servers name level data.
        'export.placeholder',
        'history.quoted',
        'history.quotedField',
        'modals.form.bpm.label',
        'modals.form.key.names.alt',
        'modals.form.key.names.backspace',
        'modals.form.key.names.ctrl',
        'modals.form.key.names.delete',
        'modals.form.key.names.end',
        'modals.form.key.names.enter',
        'modals.form.key.names.escape',
        'modals.form.key.names.home',
        'modals.form.key.names.insert',
        'modals.form.key.names.pageDown',
        'modals.form.key.names.pageUp',
        'modals.form.key.names.shift',
        'modals.form.key.names.space',
        'modals.form.key.names.tab',
        'modals.form.listJoin',
        'modals.form.sentenceJoin',
        // "BGM", as in its other strings.
        'settings.editor.waveformVisualization.fft',
        'tools.bpm.title',
        'workspace.folders.path',
        'workspace.manager.copyName',
        'workspace.properties.kinds.bpm',
    ],
    zhs: [
        'commands.bpm.title',
        'commands.events.title',
        'commands.visibilities.toggle.types.bpm',
        // A file name, as Sonolus servers name level data.
        'export.placeholder',
        'history.quotedField',
        'modals.form.bpm.label',
        'modals.form.key.names.alt',
        'modals.form.key.names.backspace',
        'modals.form.key.names.ctrl',
        'modals.form.key.names.delete',
        'modals.form.key.names.end',
        'modals.form.key.names.enter',
        'modals.form.key.names.escape',
        'modals.form.key.names.home',
        'modals.form.key.names.insert',
        'modals.form.key.names.pageDown',
        'modals.form.key.names.pageUp',
        'modals.form.key.names.shift',
        'modals.form.key.names.space',
        'modals.form.key.names.tab',
        // "BGM" as in its other BGM strings.
        // "BGM", as in its other strings.
        'tools.bpm.title',
        'workspace.folders.path',
        'workspace.manager.copyName',
        'workspace.properties.kinds.bpm',
    ],
    zht: [
        'commands.bgm.title',
        'commands.bpm.title',
        'commands.events.title',
        'commands.toggleVolume.type.bgm',
        'commands.visibilities.toggle.types.bpm',
        // A file name, as Sonolus servers name level data.
        'export.placeholder',
        'history.quoted',
        'history.quotedField',
        'modals.form.bpm.label',
        'modals.form.key.names.alt',
        'modals.form.key.names.backspace',
        'modals.form.key.names.ctrl',
        'modals.form.key.names.delete',
        'modals.form.key.names.end',
        'modals.form.key.names.enter',
        'modals.form.key.names.escape',
        'modals.form.key.names.home',
        'modals.form.key.names.insert',
        'modals.form.key.names.pageDown',
        'modals.form.key.names.pageUp',
        'modals.form.key.names.shift',
        'modals.form.key.names.space',
        'modals.form.key.names.tab',
        // "BGM" as in its other BGM strings.
        'open.media.bgm',
        // "BGM", as in its other strings.
        'save.bgm',
        'settings.editor.waveformVisualization.fft',
        'tools.bpm.title',
        'utilities.previewEditor.bgm',
        'workspace.folders.path',
        'workspace.manager.copyName',
        'workspace.properties.kinds.bpm',
    ],
}

test('a non-English value is not identical to English, except where it is allowed', () => {
    for (const locale of Object.keys(identicalToEnglish)) {
        const allowed = new Set(identicalToEnglish[locale])
        const messages = read(locale)
        for (const [key, text] of Object.entries(messages))
            if (text === english[key])
                assert.ok(allowed.has(key), `${locale} ${key} is identical to English`)
        // A stale entry would hide a later copy.
        for (const key of allowed)
            assert.equal(messages[key], english[key], `${locale} ${key} is allowed but differs`)
    }
})

// Web strings never say draft, document or project, except "project file" (Part 0 section 0.11.3).
// App-only keys, their prefixes and the "App" suffix are exempt; Stage 1 has none.
const APP_ONLY_KEYS: string[] = []
const APP_ONLY_PREFIXES: string[] = []

test('English web strings do not say draft, document or project', () => {
    const exempt = (key: string) =>
        APP_ONLY_KEYS.includes(key) ||
        APP_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
        key.endsWith('App')
    for (const [key, text] of Object.entries(english)) {
        if (exempt(key)) continue
        assert.doesNotMatch(
            text.replace(/project files?/gi, ''),
            /\b(draft|document|project)s?\b/i,
            key,
        )
    }
})

test('notification.title is gone from every locale', () => {
    for (const locale of Object.keys(identicalToEnglish))
        assert.ok(!('notification.title' in read(locale)), locale)
    assert.ok(!('notification.title' in english))
})

test('shortcut refusal notes end in a full stop, as in English', () => {
    for (const locale of ['en', 'fr', 'tr', 'zhs', 'zht'])
        for (const key of ['modals.form.key.reserved', 'modals.form.key.altGraph'])
            assert.match(read(locale)[key]!, /[.。]$/, `${locale} ${key}`)
})

test('event tool names start with a capital where the script has case', () => {
    for (const locale of readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)) {
        const messages = read(locale)
        for (const [key, text] of Object.entries(messages)) {
            if (!key.startsWith('events.')) continue
            const first = text.charAt(0)
            assert.equal(first, first.toLocaleUpperCase(locale), `${locale} ${key}`)
        }
    }
})

test('Turkish command titles use Title Case', () => {
    const messages = read('tr')
    const titles = Object.entries(messages).filter(
        ([key]) =>
            key.startsWith('commands.') && !key.includes('.modal.') && /\.title(\.|$)/.test(key),
    )
    for (const [key, text] of [
        ...titles,
        ...['contextMenu.title', 'contextMenu.editProperties', 'elevation.edit'].map(
            (key) => [key, messages[key]!] as const,
        ),
    ])
        for (const word of text.replace(/\{\d+\}/g, '').split(/[\s/]+/)) {
            const first = word.match(/\p{L}/u)?.[0]
            if (first) assert.equal(first, first.toLocaleUpperCase('tr'), `tr ${key}: ${text}`)
        }
})

test('Step Details quoting wrappers and count phrases exist in every locale', () => {
    for (const locale of readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)) {
        const messages = read(locale)
        for (const key of ['history.quoted', 'history.quotedField'])
            assert.equal(placeholders(messages[key]!).join(), '{0}', `${locale} ${key}`)
        // A name is always quoted; only Japanese also quotes a field label (to end a doubled を).
        assert.match(messages['history.quoted']!, /^["“「]\{0\}["”」]$/, locale)
        assert.equal(messages['history.quotedField'] !== '{0}', locale === 'ja', locale)
        for (const kind of [
            'note',
            'bpm',
            'timeScale',
            'event',
            'group',
            'stage',
            'groupFolder',
            'stageFolder',
        ]) {
            const text = messages[`history.details.counts.${kind}`]!
            assert.ok(text.includes('{0}'), `${locale} ${kind}`)
            // English and French count 0 and 1 apart from the rest; the other locales have one form.
            assert.equal(
                forms(text).length,
                locale === 'en' || locale === 'fr' ? 2 : 1,
                `${locale} ${kind}`,
            )
        }
    }
})
