import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

type Localization = { [key: string]: string | Localization }
const source = new URL('../../src/', import.meta.url)
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
            readFileSync(new URL(`i18n/${locale}/index.json`, source), 'utf8'),
        ) as Localization,
    )
const english = read('en')
const locales = readdirSync(new URL('i18n/', source), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

const sources = (() => {
    const files: string[] = []
    const strings = new URL('i18n/', source).href
    const walk = (directory: URL) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
            if (entry.isDirectory()) {
                if (child.href !== strings) walk(child)
            } else if (/\.(ts|vue)$/.test(entry.name)) {
                files.push(readFileSync(child, 'utf8'))
            }
        }
    }
    walk(source)
    return files
})()

const BEFORE = String.raw`(?<![A-Za-z0-9_$])`
const AFTER = String.raw`(?![A-Za-z0-9_$])`
const word = (name: string) => new RegExp(`${BEFORE}${name}${AFTER}`)

/**
 * Whether some source file refers to the key: the parent's name followed by the key's, or, where
 * the section is held under another name (`strings.value.leaf`, a destructured section), a file
 * that names the section and also reads the leaf as a property, a quoted literal or a destructured
 * name. It is a static, name-based scan, not a proof: it catches a key nobody names, and the
 * dynamic patterns below are listed by hand.
 */
const referenced = (key: string) => {
    const segments = key.split('.')
    const leaf = segments.at(-1)!
    const parent = segments.at(-2)
    if (!parent) return sources.some((text) => word(leaf).test(text))
    const direct = new RegExp(String.raw`${BEFORE}${parent}\??\.${leaf}${AFTER}`)
    const section = word(parent)
    const property = new RegExp(
        String.raw`\.${leaf}${AFTER}|\['${leaf}'\]|'${leaf}'|"${leaf}"|[{,]\s*${leaf}\s*[,}:]`,
    )
    return sources.some((text) => direct.test(text) || (section.test(text) && property.test(text)))
}

/**
 * Sections whose keys are chosen at run time by a typed value (a reason, a kind, a key name), so
 * no source names them. The types make each one required where it is read; a key added under one
 * of these without a reader is only caught by review. Each entry is reviewed, and a prefix that no
 * longer matches a key must be dropped.
 */
const dynamic: Record<string, string> = {
    'commands.open.refusals.': 'ImportRefusal reason names',
    'commands.previewAssets.noun.': 'Record<AssetType>',
    'commands.previewAssets.import.': 'Record<ImportErrorCode>',
    'commands.previewAssets.serverImport.': 'Record<ImportErrorCode> for a server item',
    'commands.previewAssets.part.': 'the part named by the refused entry',
    'commands.previewAssets.server.': 'the server error kinds',
    'settings.editor.theme.': 'the setting’s options',
    'settings.preview.position.': 'the setting’s options',
    'settings.preview.transport.': 'the setting’s options',
    'settings.preview.controls.': 'the setting’s options',
    'workspace.dock.': 'the setting’s options',
    'storage.': 'StorageLineKey',
    'save.': 'FileErrorKey',
    'name.': 'the file name problem’s reason',
    'tools.brush.kinds.': 'PropertyKind',
    'modals.form.key.names.': 'the key’s name from the event',
    'modals.loading.': 'TaskFailureKind',
    'peek.loadingShort': 'fixedLines in history/changes.ts, read through fixedLine',
    'peek.unavailableShort': 'fixedLines in history/changes.ts, read through fixedLine',
    'history.summary.movedGroupsInto': 'moved${suffix}Into in operationPresentation/format.ts',
    'history.summary.movedGroupsOut': 'moved${suffix}Out in operationPresentation/format.ts',
    'history.summary.movedStagesInto': 'moved${suffix}Into in operationPresentation/format.ts',
    'history.summary.movedStagesOut': 'moved${suffix}Out in operationPresentation/format.ts',
}

/**
 * The History presentation builds these names from an action and a subject
 * (operationPresentation/format.ts), and TypeScript requires the whole family of each template, so
 * a name outside every family and not named in a source file is unused.
 */
const subjects = '(Notes|Bpm|TimeScales|Events|Objects)'
const owners = '(Groups|Stages|GroupFolders|StageFolders)'
const families: Record<string, RegExp[]> = {
    'history.summary.': [
        /^(added|edited|moved)(Notes|Bpm|TimeScales|Events)$/,
        new RegExp(`^(deleted|cut|brushed)${subjects}$`),
        new RegExp(`^setOn${subjects}$`),
        new RegExp(`^setValueOn${subjects}$`),
        new RegExp(`^(added|duplicated|deleted)${owners}$`),
        /^(duplicated|deleted)(Groups|Stages)AndFolders$/,
    ],
    'history.operation.': [
        new RegExp(`^setValueOn${subjects}$`),
        new RegExp(`^changedOn${subjects}$`),
        /^(deleted|cut|brushed)(Notes|Bpm|TimeScales|Events)$/,
        new RegExp(`^(added|duplicated|deleted)${owners}$`),
        /^(duplicated|deleted)(Groups|Stages)AndFolders$/,
        /^renamed(Group|Stage)(Folder)?$/,
        /^renamedTo(Group|Stage)Folder$/,
        /^moved(Group|Stage)s?(Into|Out)$/,
        /^(added|duplicated|deleted|moved)Named(Group|Stage)Folder$/,
        /^created(Group|Stage)FolderWith$/,
        /^changed(Group|Stage)Properties$/,
    ],
}
const inFamily = (key: string) =>
    Object.entries(families).some(
        ([prefix, patterns]) =>
            key.startsWith(prefix) &&
            patterns.some((pattern) => pattern.test(key.slice(prefix.length))),
    )

// Messages that were shown or planned but are no longer read; they come back only by being used.
const removed = [
    'peek.viewing',
    'peek.viewingShort',
    'peek.notesOf',
    'peek.eventsOf',
    'history.edits',
    'history.initialize',
    'file.saved',
    'file.notConfirmed',
    'file.changedSinceSaved',
    'file.changedSinceDownload',
    'file.changedSinceOpened',
    'file.short.saved',
    'file.short.changed',
    'file.short.downloaded',
    'file.short.opened',
    'file.short.notConfirmed',
    'tools.eraser.erased',
    'tools.slide.edited',
    'entry.recovered',
    'entry.recoveredDropped',
    'workspace.folders.movedInto',
    'workspace.folders.movedOut',
    'commands.reset.reset',
    'sidebars.default.set',
    'sidebars.default.setNotes',
    'sidebars.default.setBpm',
    'sidebars.default.setTimeScales',
    'sidebars.default.setEvents',
    'sidebars.default.editedNotes',
]

test('every English message is read by some source file', () => {
    const unused = Object.keys(english).filter(
        (key) =>
            !referenced(key) &&
            !inFamily(key) &&
            !Object.keys(dynamic).some((prefix) => key.startsWith(prefix)),
    )
    assert.deepEqual(
        unused,
        [],
        'unused messages: remove them from all locales, or list the access pattern',
    )
})

test('every dynamic-access entry still matches a message', () => {
    for (const prefix of Object.keys(dynamic))
        assert.ok(
            Object.keys(english).some((key) => key.startsWith(prefix)),
            `${prefix} matches no message`,
        )
})

test('the scan finds a key that nothing names', () => {
    assert.equal(referenced('peek.neverNamedAnywhere'), false)
    assert.equal(referenced('commands.reset.title'), true)
})

test('removed messages stay out of every locale', () => {
    for (const locale of locales) {
        const keys = new Set(Object.keys(read(locale)))
        for (const key of removed) assert.ok(!keys.has(key), `${locale}.${key} came back`)
    }
})

// SaveDialog.vue links "Export Level Data…" inside `save.exportHint` by finding the command's
// title in the hint, and shows no link when a locale words one without the other.
test('the Save dialog’s export hint contains the Export command’s title in every locale', () => {
    for (const locale of locales) {
        const messages = read(locale)
        const hint = messages['save.exportHint']!
        const title = messages['commands.exportLevel.title']!
        assert.ok(title, `${locale}: commands.exportLevel.title`)
        assert.ok(hint.includes(title), `${locale}: save.exportHint lacks "${title}"`)
        assert.ok(hint.trim() !== title, `${locale}: the hint is only the link`)
    }
})

// labelText.ts joins the file line's event to the status label by dropping the leading "{0} · ".
test('the file line’s opened and downloaded events start with "{0} · " in every locale', () => {
    for (const locale of locales) {
        const messages = read(locale)
        for (const key of ['file.opened', 'file.downloaded']) {
            const text = messages[key]!
            assert.ok(/^\{0\} · /.test(text), `${locale}.${key} does not start with "{0} · "`)
            assert.ok(
                !text.replace(/^\{0\} · /, '').includes('{0}'),
                `${locale}.${key} names {0} again after the prefix`,
            )
        }
    }
})
