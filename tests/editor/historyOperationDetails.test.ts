import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { resolveZone } from '../../src/calendar/calendar'
import {
    captureOperationRecipe,
    describeMember,
    describeOperation,
    message,
    operationDetails,
    operationStepCount,
    type DetailRow,
    type OperationDetails,
    type OperationTextContext,
} from '../../src/history/operationPresentation'
import {
    captureEntryDescription,
    captureOperation,
    captureStep,
    createOperation,
    createRecoveryContext,
    type NativeOperationInput,
} from '../../src/history/operations'

const locales = ['en', 'fr', 'ja', 'ko', 'tr', 'zhs', 'zht'] as const
const contexts = new Map<string, OperationTextContext>()
const context = (locale = 'en'): OperationTextContext => {
    let ctx = contexts.get(locale)
    if (!ctx) {
        ctx = {
            locale,
            strings: JSON.parse(
                readFileSync(
                    new URL(`../../src/i18n/${locale}/index.json`, import.meta.url),
                    'utf8',
                ),
            ),
            now: Date.UTC(2026, 9, 19, 12, 0, 0),
            // A fixed zone, so the snapshot is the same on every machine and in CI.
            zone: resolveZone('UTC'),
        }
        contexts.set(locale, ctx)
    }
    return ctx
}
const en = context()

// --- The inventory --------------------------------------------------------------------------------
// The cases of the Step Details inventory, in the stored shapes. A case holds what a producer can emit
// (the codecs refuse zero counts, empty optional maps, a displaced entry on an add, a time out of range
// and an empty paste). One that holds a shape the codec accepts and no producer emits says so in its
// note ("Not produced today"); it checks that Step Details reads whatever is stored.
type Spec = {
    input?: NativeOperationInput
    raw?: unknown
    kind?:
        'edit' | 'restore' | 'undo' | 'redo' | 'init' | 'continue' | 'save' | 'export' | 'recovered'
    time?: number
    recovery?: {
        head: Spec & { kind: 'init' | 'edit' | 'restore' }
        headIndex: number
        dropped: (Spec & { kind: 'init' | 'edit' | 'restore' })[]
        omitted?: number
    }
}
type Case = {
    id: string
    cat: string
    note?: string
    members: Spec[]
    partial?: boolean
    direction?: 'undo' | 'redo'
    locales?: boolean
}
const cases = JSON.parse(
    readFileSync(new URL('./historyOperationDetails.cases.json', import.meta.url), 'utf8'),
) as Case[]

const T0 = Date.UTC(2026, 9, 19, 12, 34, 56)
const operationOf = (spec: Spec, ctx: OperationTextContext) =>
    spec.raw !== undefined
        ? captureOperation(spec.raw)
        : createOperation(spec.input!, {
              locale: ctx.locale,
              describe: (input) => describeOperation(input, ctx),
          })
const memberOf = (spec: Spec, index: number, total: number, ctx: OperationTextContext) => {
    const kind = spec.kind ?? 'edit'
    const operation = operationOf(spec, ctx)
    const time = spec.time ?? T0 - (total - 1 - index) * 7000
    let description
    if (kind === 'edit' || kind === 'restore' || kind === 'undo' || kind === 'redo')
        description = captureEntryDescription({
            kind,
            step: captureStep({ kind: kind === 'restore' ? 'restore' : 'edit', operation }),
        })
    else if (kind === 'recovered') {
        const r = spec.recovery
        const step = (s: Spec & { kind: 'init' | 'edit' | 'restore' }) => ({
            kind: s.kind,
            operation: operationOf(s, ctx),
        })
        description = captureEntryDescription({
            kind,
            operation,
            recoveryContext: r
                ? createRecoveryContext(step(r.head), r.dropped.map(step), r.headIndex, r.omitted)
                : createRecoveryContext({ kind: 'edit', operation: null }, [], 0, 0),
        })
    } else description = captureEntryDescription({ kind, operation })
    return { description, time, id: `m${index}` }
}
const recipeOf = (spec: Case, ctx: OperationTextContext) =>
    captureOperationRecipe(
        spec.members.map((member, index) => memberOf(member, index, spec.members.length, ctx)),
        {
            ...(spec.partial ? { partial: true } : {}),
            ...(spec.direction ? { direction: spec.direction } : {}),
        },
    )

// --- Snapshots ------------------------------------------------------------------------------------
// A readable text per case. Set UPDATE_SNAPSHOTS=1 to rewrite the file after a deliberate change.
const rowText = (row: DetailRow) => {
    const text = (value: { text: string; placeholder?: true; shortened?: true }) =>
        `${value.placeholder ? '~' : ''}${value.text}${value.shortened ? ' [shortened]' : ''}`
    switch (row.kind) {
        case 'counts':
            return `${row.label} [${row.key}]: ${row.items.join(' / ')}`
        case 'change':
            return `${row.label} [${row.key}]: ${text(row.before)} > ${text(row.after)}`
        case 'value':
            return `${row.label} [${row.key}]: ${text(row.value)}`
    }
}
const snapshotOf = (id: string, locale: string, details: OperationDetails) =>
    [
        `#${id} ${locale}`,
        `T: ${details.description}${details.descriptionLang ? ` (lang ${details.descriptionLang})` : ''}`,
        ...(details.note ? [`N: ${details.note}`] : []),
        ...details.rows.map((row) => `R: ${rowText(row)}`),
        ...details.facts.map((fact) => `F: ${fact}`),
        ...(details.steps
            ? [
                  `S: ${details.steps.count}${details.steps.partial ? '+' : ''} steps${details.steps.prefixless ? ' (no prefix)' : ''}`,
                  ...details.steps.members.map(
                      ({ label, expandable }) => `  ${expandable ? '+' : '-'} ${label}`,
                  ),
              ]
            : []),
        ...(details.recovery
            ? [
                  `E: ${details.recovery.descriptions.length} earlier, head ${details.recovery.headIndex}, omitted ${details.recovery.omitted}`,
              ]
            : []),
    ].join('\n')

const snapshotFile = new URL('./historyOperationDetails.snap.txt', import.meta.url)

const emptyContent = (details: OperationDetails) =>
    !details.rows.length && !details.facts.length && !details.note && !details.recovery

// --- Invariants over every case and every locale --------------------------------------------------
const allText = (details: OperationDetails) => [
    details.description,
    details.note ?? '',
    ...details.facts,
    ...details.rows.flatMap((row) => [
        row.label,
        ...(row.kind === 'counts'
            ? row.items
            : row.kind === 'change'
              ? [row.before.text, row.after.text]
              : [row.value.text]),
    ]),
    ...(details.steps?.members.map(({ label }) => label) ?? []),
]

const check = (spec: Case, locale: string) => {
    const ctx = context(locale)
    const recipe = recipeOf(spec, ctx)
    const details = operationDetails(recipe, ctx)
    const where = `${spec.id} ${locale}`
    // The model is a pure function of the recipe: no title is empty or unresolved.
    assert(details.description.length > 0, `${where}: empty title`)
    for (const text of allText(details)) {
        assert(!/\{\d+\}/.test(text), `${where}: unresolved placeholder in "${text}"`)
        assert(!/undefined|\[object|NaN/.test(text), `${where}: bad text "${text}"`)
        assert(!/#\d/.test(text), `${where}: internal id in "${text}"`)
        assert.notEqual(text, ctx.strings.historyChanges.notPresent, where)
    }
    // No empty section, no row without items, no zero.
    const labels = new Set<string>()
    const keys = new Set<string>()
    for (const row of details.rows) {
        assert(row.label.length > 0 && row.key.length > 0, `${where}: unlabeled row`)
        assert(!labels.has(row.label), `${where}: duplicate label ${row.label}`)
        assert(!keys.has(row.key), `${where}: duplicate key ${row.key}`)
        labels.add(row.label)
        keys.add(row.key)
        assert.notEqual(row.label, details.description, `${where}: label equals the title`)
        if (row.kind === 'counts') {
            assert(row.items.length > 0, `${where}: empty counts row ${row.key}`)
            for (const item of row.items) {
                assert(!/^0(\D|$)/.test(item), `${where}: zero count "${item}"`)
                assert.notEqual(item, details.description, `${where}: row repeats the title`)
            }
            assert.equal(new Set(row.items).size, row.items.length, `${where}: repeated phrase`)
        } else if (row.kind === 'change') {
            assert(row.before.text.length > 0 && row.after.text.length > 0, where)
            assert(
                row.before.text !== row.after.text ||
                    !row.before.placeholder !== !row.after.placeholder,
                `${where}: ${row.key} does not change`,
            )
            for (const side of [row.before, row.after]) {
                if (side.placeholder)
                    assert(
                        [
                            ctx.strings.historyChanges.notSet,
                            ctx.strings.history.details.varying,
                        ].includes(side.text),
                    )
            }
            assert.notEqual(row.label, row.before.text, where)
            assert.notEqual(row.label, row.after.text, where)
        } else {
            assert(row.value.text.length > 0, where)
            assert.notEqual(row.label, row.value.text, `${where}: label equals its value`)
            assert.notEqual(
                row.value.text,
                details.description,
                `${where}: value repeats the title`,
            )
        }
    }
    assert.equal(new Set(details.facts).size, details.facts.length, `${where}: repeated fact`)
    for (const fact of details.facts) assert.notEqual(fact, details.description, where)
    if (details.facts.includes(ctx.strings.history.details.textShortened))
        assert.equal(
            details.facts.at(-1),
            ctx.strings.history.details.textShortened,
            `${where}: the shortened-name fact comes last`,
        )
    // A note and rows exclude each other: nothing more is shown for an unreadable step.
    if (details.note) assert.deepEqual([details.rows.length, details.facts.length], [0, 0], where)
    // Parents list newest first, and a step opens only onto a record that has content.
    if (details.steps) {
        assert.equal(details.steps.members.length, recipe.members.length, where)
        assert.equal(details.steps.count, recipe.members.length, where)
        assert.deepEqual(
            details.steps.members.map(({ member }) => member.id),
            [...recipe.members].reverse().map(({ id }) => id),
            `${where}: steps are newest first`,
        )
        const times = details.steps.members.map(({ member }) => member.time ?? 0)
        assert.deepEqual(
            times,
            [...times].sort((a, b) => b - a),
            where,
        )
        assert.equal(
            details.steps.prefixless === true,
            recipe.kind === 'undo' || recipe.kind === 'redo',
        )
        for (const step of details.steps.members) {
            const own = operationDetails(captureOperationRecipe([step.member]), ctx)
            assert.equal(
                step.expandable,
                !emptyContent(own),
                `${where}: ${step.label} expandable mismatch`,
            )
            if (details.steps.prefixless)
                assert(
                    !step.label.startsWith(`${ctx.strings.commands.undo.title} · `) &&
                        !step.label.startsWith(`${ctx.strings.commands.redo.title} · `),
                    `${where}: prefix in "${step.label}"`,
                )
        }
    } else assert.equal(recipe.kind, 'single', where)
    return { recipe, details }
}

test('every inventory case renders a clean record in all seven locales', () => {
    assert(cases.length >= 222, `${cases.length} cases`)
    assert.equal(new Set(cases.map(({ id }) => id)).size, cases.length)
    let checked = 0
    for (const spec of cases)
        for (const locale of locales) {
            check(spec, locale)
            checked++
        }
    assert.equal(checked, cases.length * locales.length)
})

test('the records match their snapshots', () => {
    const lines: string[] = []
    for (const spec of cases)
        for (const locale of spec.locales ? (['en', 'fr', 'ja'] as const) : (['en'] as const))
            lines.push(snapshotOf(spec.id, locale, check(spec, locale).details), '')
    const actual = lines.join('\n')
    if (process.env.UPDATE_SNAPSHOTS || !existsSync(snapshotFile)) {
        writeFileSync(snapshotFile, actual)
        return
    }
    const expected = readFileSync(snapshotFile, 'utf8').split('\n\n')
    const got = actual.split('\n\n')
    for (let i = 0; i < Math.max(expected.length, got.length); i++)
        assert.equal(got[i], expected[i], `snapshot ${i}: ${expected[i]?.split('\n')[0]}`)
})

// --- Family rules ---------------------------------------------------------------------------------
const byId = (id: string, locale = 'en') => {
    const spec = cases.find((c) => c.id === id)
    assert(spec, id)
    return check(spec, locale).details
}
const rowOf = (details: OperationDetails, key: string) =>
    details.rows.find((row) => row.key === key)
const items = (details: OperationDetails, key: string) => {
    const row = rowOf(details, key)
    assert(row?.kind === 'counts', key)
    return row.items
}
// A placeholder (Not set, Varies) is marked with ~.
const change = (details: OperationDetails, key: string) => {
    const row = rowOf(details, key)
    assert(row?.kind === 'change', key)
    const side = (value: { text: string; placeholder?: true }) =>
        `${value.placeholder ? '~' : ''}${value.text}`
    return `${side(row.before)} > ${side(row.after)}`
}

test('a title that says everything is the minimal form', () => {
    for (const id of [
        'note.add.5',
        'note.generate.12',
        'object.add.timeScale',
        'object.edit.note3',
        'object.edit.bpm.noDisplaced',
        'object.move.note4',
        'object.replace.bpm',
        'delete.note3',
        'cut.note2',
        'note.elevation.2',
        'note.vertical.3',
        'note.combine.3',
        'note.split.2',
        'note.split.1',
        'owner.rename.group',
        'owner.moveMany.groups.into',
        'owner.delete.group',
        'owner.duplicate.group',
        'owner.create.group',
        'origin.import.source',
        'continue.plain',
        'file.save.file',
        'file.save.download',
        'file.export.file',
        'restore.plain',
        'external.change',
    ]) {
        const details = byId(id)
        assert.deepEqual(details.rows, [], id)
        assert.deepEqual(details.facts, [], id)
    }
})

test('counts appear only when the title lacks them', () => {
    // "objects" and mixed kinds
    assert.deepEqual(items(byId('delete.mixed'), 'removed'), [
        '3 notes',
        '1 BPM change',
        '2 camera events',
    ])
    assert.deepEqual(items(byId('object.move.objects.collateral'), 'changed'), [
        '3 notes',
        '1 BPM change',
        '2 camera events',
    ])
    assert.deepEqual(items(byId('flip.horizontal.note'), 'changed'), ['4 notes'])
    assert.deepEqual(items(byId('flip.vertical.collateral'), 'displaced'), ['1 time scale'])
    assert.deepEqual(items(byId('scale.beats.collateral'), 'changed'), ['8 notes', '2 BPM changes'])
    assert.deepEqual(items(byId('paste.note5'), 'placed'), ['5 notes'])
    assert.deepEqual(items(byId('paste.mixed.displaced'), 'placed'), [
        '3 notes',
        '1 BPM change',
        '2 time scales',
    ])
    assert.deepEqual(items(byId('paste.mixed.displaced'), 'displaced'), [
        '1 BPM change',
        '1 time scale',
    ])
    assert.deepEqual(items(byId('dynamicStages.enable'), 'created'), [
        '1 stage mask event',
        '1 stage pivot event',
        '1 stage style event',
    ])
    // a single kind in an edit, move or delete: the title has it
    assert.equal(rowOf(byId('object.edit.note3'), 'changed'), undefined)
    assert.equal(rowOf(byId('delete.note3'), 'removed'), undefined)
    // empty maps give no rows
    assert.deepEqual(byId('object.edit.note.empty').rows, [])
    assert.deepEqual(byId('delete.empty.nc').rows, [])
    assert.deepEqual(byId('dynamicStages.enable.empty').rows, [])
})

test('replace shows the replaced count only when it differs from the title', () => {
    assert.deepEqual(byId('object.replace.bpm').rows, [])
    assert.deepEqual(items(byId('object.replace.timeScale.moreDisplaced'), 'displaced'), [
        '2 time scales',
    ])
    assert.deepEqual(items(byId('object.replace.empty'), 'displaced'), ['1 time scale'])
    assert.deepEqual(byId('object.replace.bpm.retained').facts, ['Kept the initial BPM change'])
})

test('titles use the quantity-free form when nothing changed', () => {
    assert.equal(byId('object.edit.note.empty').description, 'Edited notes')
    assert.equal(byId('object.move.objects.empty').description, 'Moved objects')
    assert.equal(byId('object.move.bpm.emptyRetained').description, 'Moved BPM changes')
    assert.equal(byId('flip.empty').description, 'Flipped objects horizontally')
    assert.equal(byId('scale.empty').description, 'Scaled width')
    assert.equal(byId('delete.empty.nc').description, 'Deleted objects')
    assert.equal(byId('cut.empty').description, 'Cut objects')
    assert.equal(byId('note.add.0').description, 'Added notes')
    assert.equal(byId('note.generate.0').description, 'Generated notes')
    // A move of zero entries cannot be stored by any producer, but it reads without a count.
    assert.equal(byId('owner.moveMany.zero').description, 'Moved groups out of folders')
    assert.equal(
        byId('owner.moveMany.zero.into').description,
        'Moved groups into folder “Folder One”',
    )
    assert.equal(byId('owner.moveMany.zero.stages').description, 'Moved stages out of folders')
    assert.equal(
        byId('owner.moveMany.zero.stagesInto').description,
        'Moved stages into folder “Folder S”',
    )
    for (const spec of cases) {
        const { description } = check(spec, 'en').details
        assert(!/(^|\s)0 /.test(description), `${spec.id}: ${description}`)
    }
})

test('property steps show the before value, in the editor words', () => {
    const lane = byId('property.note.lane')
    assert.equal(lane.description, 'Set Lane to -2.5 on 1 note')
    assert.equal(change(lane, 'left'), '~Varies > -2.5')
    assert.equal(rowOf(byId('property.note.noop'), 'left'), undefined)
    const multi = byId('property.timeScale.multi')
    assert.deepEqual(
        multi.rows.map(({ key }) => key),
        ['hideNotes', 'timeScale', 'timeScaleTransition'],
    )
    const group = byId('property.note.group.beforeName')
    // The new group has an empty name: a group, so its name reads quoted empty, not Not set.
    assert.equal(change(group, 'groupId'), 'Old Group > “”')
    const objects = byId('brush.objects.varying')
    assert.deepEqual(items(objects, 'changed'), ['2 notes', '3 time scales'])
    const critical = byId('brush.note.1field')
    assert.equal(change(critical, 'isCritical'), '~Varies > Enabled')
})

test('header, BGM and Level values are in the editor units', () => {
    assert.equal(change(byId('header.life'), 'life'), '1,000 > 900')
    assert.equal(rowOf(byId('header.life.noChange'), 'life'), undefined)
    const offset = byId('header.bgmOffset')
    assert.equal(offset.description, 'Set BGM Offset to 1,234.5678901234567 ms')
    const row = rowOf(offset, 'offset')
    assert.equal(row?.label, en.strings.commands.bgm.modal.offset)
    assert(row.label.includes('(ms)'))
    assert.equal(change(byId('header.bgmOffset.negative'), 'offset'), '-500 > 250')
    assert.equal(change(byId('bgm.change.file'), 'file'), 'old.mp3 > new song.mp3')
    assert.equal(change(byId('bgm.change.fromNone'), 'file'), '~Not set > first.mp3')
    assert.equal(change(byId('bgm.change.toNone'), 'file'), 'old.mp3 > ~Not set')
    const both = byId('bgm.change.fileAndOffset')
    assert.equal(change(both, 'offset'), '0 > -123')
    const same = byId('bgm.change.sameFile.offset')
    assert.equal(rowOf(same, 'file')?.kind, 'value')
    assert.equal(change(same, 'offset'), '100 > 200')
    assert.equal(byId('bgm.change.sameFile.offset').description, 'Changed BGM')
    assert.equal(byId('bgm.change.file').description, 'Changed BGM file')
})

test('owner records use Not set, one term, and 1-based positions', () => {
    assert.equal(change(byId('owner.set.group.speed'), 'forceNoteSpeed'), '~Not set > 1.5')
    assert.equal(change(byId('owner.set.group.speedCleared'), 'forceNoteSpeed'), '1.5 > ~Not set')
    assert.equal(rowOf(byId('owner.set.group.speedNoChange'), 'forceNoteSpeed'), undefined)
    const multi = byId('owner.set.stage.multi')
    assert.deepEqual(
        multi.rows.map(({ key }) => key),
        ['generateSimLines', 'isFromStart', 'isUntilEnd'],
    )
    assert.equal(
        multi.description,
        'Changed Generate Sim Lines, From Start, and Until End for stage “Left”',
    )
    assert.equal(change(multi, 'isFromStart'), 'Disabled > Enabled')
    assert.equal(change(byId('owner.move.reorder.indexes'), 'order'), '3 > 1')
    assert.equal(rowOf(byId('owner.move.reorder.noIndexes'), 'order'), undefined)
    assert.equal(rowOf(byId('owner.move.reorder.fromOnly'), 'order'), undefined)
    assert.equal(rowOf(byId('owner.move.reorder.sameIndex'), 'order'), undefined)
    assert.equal(rowOf(byId('owner.move.intoFolder'), 'order'), undefined)
    assert.equal(change(byId('owner.move.folderReorder'), 'order'), '2 > 1')
    const inFolder = byId('owner.create.group.inFolder')
    const folder = rowOf(inFolder, 'folder')
    assert(folder?.kind === 'value')
    assert.equal(folder.value.text, 'Folder One')
    // A folder with an empty name is still a folder: its name reads as an empty name, quoted as
    // in prose, and is not the placeholder for no folder.
    assert.deepEqual(rowOf(byId('owner.create.stage.inFolder'), 'folder'), {
        kind: 'value',
        key: 'folder',
        label: 'Folder',
        value: { text: '“”' },
    })
    assert.deepEqual(items(byId('owner.ungroup.3'), 'released'), ['3 groups'])
    assert.deepEqual(byId('owner.ungroup.stage0').rows, [])
    assert.equal(byId('owner.create.group.emptyName').description, 'Added group “”')
})

test('cascades and replacements are recorded in the dialog only', () => {
    const del = byId('owner.delete.cascade')
    assert.equal(del.description, 'Deleted group “Alpha”')
    assert.deepEqual(items(del, 'removed'), ['1 group', '800 notes', '12 time scales'])
    assert.deepEqual(del.facts, ['Added group “Group 1”'])
    const folder = byId('owner.delete.cascade.stageFolder')
    assert.deepEqual(items(folder, 'removed'), [
        '2 stages',
        '1 stage folder',
        '4 stage transform events',
    ])
    assert.deepEqual(byId('owner.delete.folderOnly').rows, [])
    assert.deepEqual(byId('owner.delete.counts.noCascade').rows, [])
    const copy = byId('owner.duplicate.cascade')
    assert.equal(copy.description, 'Duplicated group “Alpha”')
    assert.deepEqual(items(copy, 'added'), ['1 group', '120 notes', '1 time scale'])
    assert.deepEqual(byId('owner.duplicate.folderOnly').rows, [])
})

test('a group of owner deletes or duplicates shows the cascade its steps carry', () => {
    // Deleted groups: the owners, then the objects deleted with them, then the replacement.
    const del = byId('group.ownerDelete.cascade')
    assert.equal(del.description, 'Deleted 3 groups')
    assert.deepEqual(items(del, 'removed'), ['3 groups', '5 notes', '1 time scale'])
    assert.deepEqual(items(del, 'added'), ['1 group'])
    assert.equal(rowOf(del, 'added')?.label, 'Added')
    // A replacement alone is a cascade too; without objects the owner total repeats the title.
    const only = byId('group.ownerDelete.replacementOnly')
    assert.equal(rowOf(only, 'removed'), undefined)
    assert.deepEqual(items(only, 'added'), ['1 group'])
    const copy = byId('group.ownerDuplicate.cascade')
    assert.equal(copy.description, 'Duplicated 2 groups')
    assert.deepEqual(items(copy, 'added'), ['2 groups', '125 notes', '1 time scale'])
    // No objects and no replacement: nothing beyond the title.
    assert.deepEqual(byId('group.ownerDelete.group.2').rows, [])
})

test('groups show net rows and totals only where the title lacks them', () => {
    assert.equal(change(byId('group.header.life.3'), 'life'), '1 > 4')
    assert.equal(change(byId('group.header.bgmOffset.2'), 'offset'), '0 > 500')
    assert.equal(change(byId('group.ownerSet.varying'), 'forceNoteSpeed'), '~Not set > 2')
    assert.equal(change(byId('group.ownerSet.uniform'), 'forceNoteSpeed'), '~Not set > 2')
    assert.equal(change(byId('group.ownerMove.reorder'), 'order'), '4 > 1')
    assert.deepEqual(items(byId('group.delete.mixedKinds'), 'removed'), [
        '3 notes',
        '2 BPM changes',
    ])
    assert.deepEqual(items(byId('group.delete.mixed.three'), 'removed'), [
        '3 notes',
        '3 BPM changes',
        '5 time scales',
    ])
    // The title already has these totals, or the sum cannot be trusted.
    for (const id of [
        'group.noteAdd.3',
        'group.noteGenerate.2',
        'group.objectAdd.bpm.3',
        'group.delete.3',
        'group.cut.2',
        'group.delete.huge',
        'group.ownerCreate.group.3',
        'group.ownerDuplicate.2',
        'group.ownerDelete.group.2',
        'group.ownerDelete.withFolders',
        'group.ownerRename.chain',
        'group.ownerRename.netZero',
        'group.ownerMove.intoFolder',
        // Edits, moves, brushes, flips and scales would count one object twice.
        'group.objectEdit.note.3',
        'group.objectMove.note.4',
        'group.objectReplace.bpm.2',
        'group.brush.2',
        'group.flip.2',
        'group.scale.2',
        'group.paste.2',
        'group.property.varying',
        'group.property.same',
    ])
        assert.deepEqual(byId(id).rows, [], id)
})

test('a group lists its steps newest first under the step count', () => {
    const ctx = en
    const spec = cases.find(({ id }) => id === 'group.property.varying')!
    const recipe = recipeOf(spec, ctx)
    const details = operationDetails(recipe, ctx)
    assert.equal(operationStepCount(recipe, ctx), '3 steps')
    assert.deepEqual(
        details.steps?.members.map(({ label }) => label),
        ['Set Lane to 3 on 2 notes', 'Set Lane to 2 on 2 notes', 'Set Lane to 1 on 2 notes'],
    )
    assert.equal(details.steps?.partial, false)
    const partial = operationDetails(recipeOf({ ...spec, partial: true }, ctx), ctx)
    assert.equal(partial.steps?.partial, true)
    assert.equal(operationStepCount(recipeOf({ ...spec, partial: true }, ctx), ctx), '3+ steps')
    // A step with no record of its own is a plain row; one with a record opens.
    const plain = operationDetails(
        recipeOf(
            cases.find(({ id }) => id === 'group.noteAdd.3')!,
            ctx,
        ),
        ctx,
    )
    assert(plain.steps?.members.every(({ expandable }) => !expandable))
    assert(details.steps?.members.every(({ expandable }) => expandable))
    // The model is read-only over the recipe, and its steps are the recipe's members.
    const before = JSON.stringify(recipe)
    const again = operationDetails(recipe, context('ja'))
    assert.equal(JSON.stringify(recipe), before)
    const members = [...recipe.members].reverse()
    again.steps?.members.forEach(({ member }, i) => assert.equal(member, members[i]))
})

test('undo and redo parents list their steps without the repeated prefix', () => {
    for (const id of ['undo.group.3', 'redo.group.2.partial', 'group.undo.mixed']) {
        const spec = cases.find((c) => c.id === id)!
        for (const locale of locales) {
            const ctx = context(locale)
            const recipe = recipeOf(spec, ctx)
            const { steps } = operationDetails(recipe, ctx)
            assert(steps?.prefixless, id)
            // Without the option the prefix is still there: the Timeline's own rows keep it.
            for (const { member, label } of steps.members) {
                assert.notEqual(describeMember(member, ctx), label, `${id} ${locale}`)
                assert(describeMember(member, ctx).endsWith(label), `${id} ${locale}`)
            }
        }
    }
    // A single crossed step keeps the prefix in its title and shows the step's own record.
    const spec: Case = {
        id: 'undo.single.paste',
        cat: 'undoredo',
        members: [
            {
                kind: 'undo',
                input: {
                    id: 'nse.object.paste',
                    data: {
                        placed: { note: 2, bpm: 1 },
                        variant: 'basic',
                        flipped: true,
                        at: 'pointer',
                    },
                },
            },
        ],
    }
    const details = check(spec, 'en').details
    assert.equal(details.description, 'Undo · Pasted 3 objects')
    assert.deepEqual(items(details, 'placed'), ['2 notes', '1 BPM change'])
    assert.deepEqual(details.facts, ['Pasted flipped'])
})

test('names and field labels are quoted the way each locale quotes them', () => {
    const title = (id: string, locale: string) => byId(id, locale).description
    assert.match(title('owner.rename.group', 'en'), /“Alpha”.*“Beta”/)
    assert.match(title('owner.rename.group', 'fr'), /«\u00a0Alpha\u00a0».*«\u00a0Beta\u00a0»/)
    assert.match(title('owner.rename.group', 'ko'), /“Alpha”.*“Beta”/)
    assert.match(title('owner.rename.group', 'tr'), /“Alpha”.*“Beta”/)
    assert.match(title('owner.rename.group', 'ja'), /「Alpha」.*「Beta」/)
    assert.match(title('owner.rename.group', 'zhs'), /“Alpha”.*“Beta”/)
    assert.match(title('owner.rename.group', 'zht'), /「Alpha」.*「Beta」/)
    // A field label in a sentence is quoted in Japanese only, so a trailing を cannot double.
    assert.match(title('property.note.lane', 'ja'), /「レーン」/)
    assert.match(title('owner.set.group.speed', 'ja'), /「ノーツ速度を固定」を1\.5に/)
    assert.doesNotMatch(title('property.note.lane', 'en'), /「|“/)
    assert.doesNotMatch(title('property.note.lane', 'zhs'), /「|“/)
    // The rows carry the bare label.
    const row = byId('owner.set.group.speed', 'ja').rows[0]
    assert.equal(row?.label, 'ノーツ速度を固定')
    // An empty name is quoted empty, in every locale's own quotes.
    for (const locale of locales) {
        const ctx = context(locale)
        assert(
            byId('owner.create.group.emptyName', locale).description.includes(
                message(ctx, ctx.strings.history.quoted, ''),
            ),
            locale,
        )
    }
})

test('every locale: units, plural phrases and count phrases are complete', () => {
    const units: Record<string, string> = {
        en: 'ms',
        fr: 'ms',
        ja: 'ミリ秒',
        ko: '밀리초',
        tr: 'ms',
        zhs: '毫秒',
        zht: '毫秒',
    }
    const everyKind = {
        note: 1,
        bpm: 2,
        timeScale: 3,
        cameraEvent: 4,
        stageMaskEvent: 5,
        stagePivotEvent: 6,
        stageStyleEvent: 7,
        stageTransformEvent: 8,
    }
    const paste = (placed: Record<string, number>): Case => ({
        id: 'every.kind',
        cat: 'paste',
        members: [
            {
                input: {
                    id: 'nse.object.paste',
                    data: { placed, variant: 'basic', flipped: false, at: 'pointer' },
                } as NativeOperationInput,
            },
        ],
    })
    const remove = (domain: 'group' | 'stage', removed: Record<string, number>): Case => ({
        id: 'every.owner',
        cat: 'owner',
        members: [
            {
                input: {
                    id: 'nse.owner.delete',
                    data: { domain, removed, objects: { note: 1 } },
                } as NativeOperationInput,
            },
        ],
    })
    for (const locale of locales) {
        const offset = byId('header.bgmOffset.negative', locale)
        assert(offset.description.includes(units[locale]!), `${locale}: ${offset.description}`)
        assert(offset.description.includes('250'), locale)
        assert(
            offset.rows[0]?.label.includes(units[locale]!),
            `${locale}: ${offset.rows[0]?.label}`,
        )
        const placed = check(paste(everyKind), locale).details.rows[0]
        assert(placed?.kind === 'counts')
        assert.equal(placed.items.length, 8, locale)
        for (const [index, item] of placed.items.entries())
            assert(item.includes(String(index + 1)) && !item.includes('|'), `${locale}: ${item}`)
        for (const [domain, removed] of [
            ['group', { group: 2, groupFolder: 2 }],
            ['stage', { stage: 1, stageFolder: 1 }],
        ] as const) {
            const row = check(remove(domain, removed), locale).details.rows[0]
            assert(row?.kind === 'counts' && row.items.length === 3, locale)
            assert(
                row.items.every((item) => !item.includes('|')),
                locale,
            )
        }
    }
    // English and French separate one from many; the other locales keep one form.
    const items = (locale: string, count: number) => {
        const row = check(paste({ note: count, bpm: count }), locale).details.rows[0]
        assert(row?.kind === 'counts')
        return row.items
    }
    assert.deepEqual(items('en', 1), ['1 note', '1 BPM change'])
    assert.deepEqual(items('en', 2), ['2 notes', '2 BPM changes'])
    assert.deepEqual(items('fr', 1), ['1 note', '1 changement de BPM'])
    assert.deepEqual(items('fr', 2), ['2 notes', '2 changements de BPM'])
    assert.deepEqual(items('ja', 2), ['2個のノーツ', '2個のBPM'])
    assert.deepEqual(items('en', 1_234_567), ['1,234,567 notes', '1,234,567 BPM changes'])
})

test('the localized notes and facts exist in every locale', () => {
    for (const locale of locales) {
        const t = context(locale).strings.history.details
        for (const text of [t.newer, t.unsupported, t.pastedFlipped, t.retainedInitialBpm])
            assert(text.length > 0 && !/\{\d+\}/.test(text), locale)
        assert.equal(byId('unknown.version2', locale).note, t.newer, locale)
        assert.equal(byId('unknown.future.fallback', locale).note, t.unsupported, locale)
        assert.equal(byId('paste.mixed.displaced', locale).facts[0], t.pastedFlipped, locale)
        assert.equal(
            byId('object.move.bpm.retained', locale).facts[0],
            t.retainedInitialBpm,
            locale,
        )
    }
})
