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
 * Whether some source file reads the key. Either the parent's name is followed by the key's
 * (`parent.leaf`, `parent?.leaf`), or the file binds the whole section (`history.details`) to a
 * name and reads the leaf through that name: `const d = t.history.details` then `d.leaf`,
 * `const text = () => i18n.value.load` then `text().leaf`, or the leaf destructured from the
 * section. A leaf that merely appears in a file that mentions the section does not count, so a
 * common leaf name (`group`, `all`, `note`) cannot hide an unused key. It is a static, name-based
 * scan, not a proof: the dynamic patterns below are listed by hand.
 */
const referenced = (key: string) => {
    const segments = key.split('.')
    const leaf = segments.at(-1)!
    const parent = segments.at(-2)
    if (!parent) return sources.some((text) => word(leaf).test(text))
    // The section is a property (`strings.history.details.leaf`), not a local named like it.
    const direct = new RegExp(String.raw`\.${parent}\??\.${leaf}${AFTER}`)
    const chain = segments.slice(0, -1).join(String.raw`\??\.`)
    const binding = String.raw`[\w$.?]*${BEFORE}${chain}${AFTER}(?!\??\.[\w$])`
    const aliases = new RegExp(
        String.raw`(?:const|let|var)\s+(\w+)\s*=\s*(?:computed\(\s*)?(?:\(\)\s*=>\s*)?${binding}`,
        'g',
    )
    const destructured = new RegExp(
        String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*${binding}`,
        'g',
    )
    // The section itself taken out of its holder: `const { status } = i18n.value`, then `status.leaf`.
    const taken = new RegExp(
        String.raw`(?:const|let|var)\s*\{[^}]*${BEFORE}${parent}${AFTER}[^}]*\}\s*=`,
    )
    const takenRead = new RegExp(String.raw`${BEFORE}${parent}\??\.${leaf}${AFTER}`)
    return sources.some(
        (text) =>
            text.includes(parent) &&
            (direct.test(text) ||
                (taken.test(text) && takenRead.test(text)) ||
                [...text.matchAll(aliases)].some(([, alias]) =>
                    new RegExp(
                        String.raw`${BEFORE}${alias}(\(\)|\.value)?\??\.${leaf}${AFTER}`,
                    ).test(text),
                ) ||
                [...text.matchAll(destructured)].some(([, list]) =>
                    list!.split(',').some((item) => item.split(':')[0]!.trim() === leaf),
                )),
    )
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
    'open.media.': 'the media name, read as open.media[line.media] in commands/open/project.ts',
    'peek.noChanges': 'fixedLines in history/changes.ts, read through fixedLine',
    'peek.unavailableShort': 'fixedLines in history/changes.ts, read through fixedLine',
    'commands.open.opened': "levelData: 'opened' in open/index.ts, read as the result’s message",
    'commands.open.imported': 'the importedChcy/Usc/Sus map in open/index.ts',
    'commands.open.revision.': 'RevisionWarning names, read as revision[message]',
    'commands.scaleBeat.': 'labelKeys in scaleSelection/labels.ts',
    'commands.scaleWidth.': 'labelKeys in scaleSelection/labels.ts',
    'commands.scaleElevation.': 'labelKeys in scaleSelection/labels.ts',
    'commands.editorLayout.': 'the layout name, read as editorLayout[layout]',
    'commands.visibilities.toggle.types.': 'the visibility key, read as types[key]',
    'commands.previewAssets.skin': 'the asset type, read as strings[type]',
    'commands.previewAssets.particle': 'the asset type, read as strings[type]',
    'commands.previewAssets.effect': 'the asset type, read as strings[type]',
    'commands.divisions.custom.modal.division':
        'the modal’s labels, chosen by axis in CustomDivisionModal.vue',
    'commands.laneDivisions.custom.modal.division':
        'the modal’s labels, chosen by axis in CustomDivisionModal.vue',
    'tools.bpm.':
        'the subject and action, read as tools[subject][action] in operationPresentation/format.ts',
    'tools.timeScale.':
        'the subject and action, read as tools[subject][action] in operationPresentation/format.ts',
    'tools.events.':
        'the subject and action, read as tools[subject][action] in operationPresentation/format.ts',
    'tools.note.':
        'the subject and action, read as tools[subject][action] in operationPresentation/format.ts',
    'tools.slide.':
        'the subject and action, read as tools[subject][action] in operationPresentation/format.ts',
    'history.summary.scaled': 'chosen by the scaled axis in operationPresentation/aggregate.ts',
    'history.details.counts.':
        'the kind, read as phrases[kind] in operationPresentation/details.ts',
    'commands.manageGroups.modal.added':
        'the action, read as modal[action] in operationPresentation/format.ts',
    'commands.manageGroups.modal.deleted':
        'the action, read as modal[action] in operationPresentation/format.ts',
    'commands.manageStages.modal.added':
        'the action, read as modal[action] in operationPresentation/format.ts',
    'commands.manageStages.modal.deleted':
        'the action, read as modal[action] in operationPresentation/format.ts',
    'history.details.pointer':
        "the paste location, read as d[at === 'pointer' ? ...] in details.ts",
    'history.details.position':
        "the paste location, read as d[at === 'pointer' ? ...] in details.ts",
    'historyChanges.fields.':
        'spread into the property labels in editor/history/propertyPresentation.ts',
    'modals.form.ease.': 'the ease name, read as ease[value] in EaseField.vue',
    'modals.form.colors.': 'the color name, read as colors[name]',
    'modals.form.key.': 'the refusal reason, read as key[refusedAs] in KeyField.vue',
    'offscreenNotes.': 'the side, read as offscreenNotes[side]',
    'workspace.panels.': 'the panel id, read as panels[id] in workspace/panels.ts',
    'workspace.docks.': 'the side, read as docks[side]',
    'workspace.collapse.': 'the side, read as collapse[side]',
    'workspace.expand.': 'the side, read as expand[side]',
    'workspace.resize.': 'the side, read as resize[side]',
    'workspace.groups.renamed':
        "workspace[group ? 'groups' : 'stages'] in operationPresentation/format.ts",
    'workspace.groups.propertySet':
        "workspace[group ? 'groups' : 'stages'] in operationPresentation/format.ts",
    'workspace.stages.renamed':
        "workspace[group ? 'groups' : 'stages'] in operationPresentation/format.ts",
    'workspace.stages.propertySet':
        "workspace[group ? 'groups' : 'stages'] in operationPresentation/format.ts",
    'workspace.properties.': 'the section name, read as properties[section] in PropertiesPanel.vue',
    'file.downloaded': 'the file event, joined in labelText.ts',
    'file.opened': 'the file event, joined in labelText.ts',
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
    'workspace.folders.added',
    'workspace.folders.renamed',
    'workspace.folders.moved',
    'workspace.folders.deleted',
    'workspace.folders.duplicated',
    'history.details.nameShortened',
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

// A common leaf name must not be satisfied by unrelated files that mention the section.
test('the scan reports made-up keys that share a leaf name with real ones', () => {
    for (const key of [
        'history.details.group',
        'history.details.note',
        'history.details.stage',
        'history.operation.title',
        'history.summary.all',
        'historyChanges.fields.name',
    ])
        assert.equal(referenced(key), false, key)
    assert.equal(referenced('history.details.changed'), true)
    assert.equal(referenced('history.details.counts.note'), true)
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
