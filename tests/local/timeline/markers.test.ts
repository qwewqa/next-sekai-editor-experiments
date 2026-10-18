import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { gzip } from 'pako'
import {
    exportByPicker,
    exportToTarget,
    type ExportContext,
    type ExportUi,
} from '../../../src/editor/commands/exportLevel/flow'
import { clearExportMemory } from '../../../src/editor/commands/exportLevel/memory'
import { onHistoryAction, type HistoryAction } from '../../../src/history/actions'
import { markExported, markSaved, setFileEventMessages } from '../../../src/history/markers'
import { pushState, resetStates } from '../../../src/history/stack'
import { recoveredLabel } from '../../../src/local/journal/label'
import { setPlatformForTests } from '../../../src/platform'
import { levelDataDiskState } from '../../../src/platform/fingerprint'
import { createMockPlatform } from '../../../src/platform/mock'
import { setInterpolationLocale } from '../../../src/utils/interpolate'
import { goldenChart, stateOf } from '../records/charts'

// The entries' labels through their real paths (§1.3.8, §1.6.4 step 4): the messages of each
// locale, the plural choice, and the file events Export Level Data… and Save record.

type Messages = {
    entry: {
        exported: string
        saved: string
        downloaded: string
        recovered: string
        recoveredDropped: string
    }
}

const messagesOf = (locale: string) =>
    JSON.parse(
        readFileSync(new URL(`../../../src/i18n/${locale}/index.json`, import.meta.url), 'utf8'),
    ) as Messages

const LOCALES = ['en', 'fr', 'ja', 'ko', 'tr', 'zhs', 'zht']

test('the recovered entry’s label names the dropped undo steps, in each locale’s plural', () => {
    try {
        setInterpolationLocale(() => 'en')
        const en = messagesOf('en')
        assert.equal(recoveredLabel(en, 0), 'Recovered last change')
        assert.equal(recoveredLabel(en, 1), 'Recovered last change. 1 undo step was dropped.')
        assert.equal(recoveredLabel(en, 2), 'Recovered last change. 2 undo steps were dropped.')
        setInterpolationLocale(() => 'fr')
        const fr = messagesOf('fr')
        assert.equal(
            recoveredLabel(fr, 1),
            'Dernière modification récupérée. 1 étape d’annulation a été supprimée.',
        )
        assert.equal(
            recoveredLabel(fr, 3),
            'Dernière modification récupérée. 3 étapes d’annulation ont été supprimées.',
        )
        for (const locale of LOCALES) {
            setInterpolationLocale(() => locale)
            const messages = messagesOf(locale)
            assert.ok(recoveredLabel(messages, 0).length > 0, locale)
            assert.ok(recoveredLabel(messages, 4).includes('4'), locale)
            assert.ok(!recoveredLabel(messages, 4).includes('{0}'), locale)
        }
    } finally {
        setInterpolationLocale(() => 'en')
    }
})

const watch = () => {
    const seen: HistoryAction[] = []
    const stop = onHistoryAction((action) => seen.push(action))
    return { seen, stop }
}

test('Export and Save record file events on the live state, labelled at write time', () => {
    let messages = messagesOf('en')
    setFileEventMessages(() => messages)
    const a = stateOf(goldenChart())
    resetStates({ isDirty: false, name: () => 'Initialize', state: a })
    pushState(() => 'Changed', { ...a, initialLife: 900 })
    const { seen, stop } = watch()
    markExported('Coconut.nsld')
    markSaved('Coconut.nsld', false)
    markSaved('Coconut.nsld', true)
    stop()
    assert.deepEqual(
        seen.map((action) => [
            action.kind,
            action.name(),
            action.isDirty,
            action.state?.initialLife,
        ]),
        [
            ['export', 'Exported Coconut.nsld', true, 900],
            ['save', 'Saved Coconut.nsld', false, 900],
            ['save', 'Downloaded Coconut.nsld', false, 900],
        ],
    )
    // In the locale when the flush reads it.
    messages = messagesOf('fr')
    assert.equal(seen[0]?.name(), 'Coconut.nsld exporté')
})

const level = () => new Blob([gzip(JSON.stringify({ bgmOffset: 0, entities: [] }))])

const ui = (marked: string[]) =>
    ({
        conflict: () => Promise.resolve(undefined),
        exported: () => undefined,
        downloadStarted: () => undefined,
        markExported: (name: string) => marked.push(name),
    }) as unknown as ExportUi

const context = (marked: string[]): ExportContext => ({
    ui: ui(marked),
    build: level,
    suggestedName: 'Coconut.nsld',
    types: [{ description: 'Next SEKAI level data', extension: '.nsld' }],
    leave: () => undefined,
})

test('Export Level Data… marks each export it completes: in place, picked or downloaded', async () => {
    const mock = createMockPlatform()
    setPlatformForTests(mock)
    clearExportMemory()
    try {
        const marked: string[] = []
        mock.writeFile('LevelData', level())
        const handle = mock.createHandle('LevelData')
        const target = {
            name: 'LevelData',
            handle,
            disk: await levelDataDiskState(await handle.getFile()),
            exported: false,
        }
        assert.equal(await exportToTarget(context(marked), target), 'done')
        mock.saveTargets.push({ kind: 'handle', handle: mock.createHandle('Other.nsld') })
        assert.equal(await exportByPicker(context(marked)), 'done')
        mock.saveTargets.push('download')
        assert.equal(await exportByPicker(context(marked)), 'done')
        mock.saveTargets.push('cancel')
        assert.equal(await exportByPicker(context(marked)), 'back')
        assert.deepEqual(marked, ['LevelData', 'Other.nsld', 'Coconut.nsld'])
    } finally {
        setPlatformForTests(undefined)
    }
})
