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
import { clearExportMemory, exportMemory } from '../../../src/editor/commands/exportLevel/memory'
import {
    describeOperation,
} from '../../../src/history/operationPresentation/format'
import type { OperationStrings } from '../../../src/history/operationPresentation/types'
import { setPlatformForTests } from '../../../src/platform'
import { levelDataDiskState } from '../../../src/platform/fingerprint'
import { createMockPlatform } from '../../../src/platform/mock'

// File events capture operation metadata once; presentation uses the current locale.
const messagesOf = (locale: string) =>
    JSON.parse(
        readFileSync(new URL(`../../../src/i18n/${locale}/index.json`, import.meta.url), 'utf8'),
    ) as OperationStrings
const LOCALES = ['en', 'fr', 'ja', 'ko', 'tr', 'zhs', 'zht']

test('recovery operation titles use current locale without claiming collapsed actions remain undoable', () => {
    for (const locale of LOCALES) {
        const strings = messagesOf(locale)
        for (const droppedSteps of [0, 1, 4]) {
            const title = describeOperation(
                { id: 'nse.recovery', data: { source: 'journal', droppedSteps } },
                { locale, strings, now: 0 },
            )
            assert.equal(title, strings.entry.recoveredChanges)
            assert(title.length > 0)
            assert(!title.includes('{0}'))
        }
    }
})

const level = () => new Blob([gzip(JSON.stringify({ bgmOffset: 0, entities: [] }))])

const ui = (marked: [string, string][]) =>
    ({
        conflict: () => Promise.resolve(undefined),
        exported: () => undefined,
        downloadStarted: () => undefined,
        markExported: (name: string, delivery: 'file' | 'download') =>
            marked.push([name, delivery]),
    }) as unknown as ExportUi

const context = (marked: [string, string][]): ExportContext => ({
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
        const marked: [string, string][] = []
        mock.writeFile('LevelData', level())
        const handle = mock.createHandle('LevelData')
        const target = {
            name: 'LevelData',
            handle,
            disk: await levelDataDiskState(await handle.getFile()),
            exported: false,
        }
        exportMemory.target = target
        assert.equal(await exportToTarget(context(marked), target), 'done')
        mock.saveTargets.push({ kind: 'handle', handle: mock.createHandle('Other.nsld') })
        assert.equal(await exportByPicker(context(marked)), 'done')
        mock.saveTargets.push('download')
        assert.equal(await exportByPicker(context(marked)), 'done')
        mock.saveTargets.push('cancel')
        assert.equal(await exportByPicker(context(marked)), 'back')
        assert.deepEqual(marked, [
            ['LevelData', 'file'],
            ['Other.nsld', 'file'],
            ['Coconut.nsld', 'download'],
        ])
    } finally {
        setPlatformForTests(undefined)
    }
})
