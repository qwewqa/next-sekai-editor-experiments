import { expect, test, type Page } from '@playwright/test'
import type { NativeOperation } from '../../src/history/operations'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

declare global {
    interface Window {
        managerOperations: NativeOperation[]
    }
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(async () => {
        const { history, fixtures } = window.editorTest
        const chart = structuredClone(fixtures.notes)
        chart.isDynamicStages = true
        history.resetState(false, chart, 0, { sourceName: 'manager-operations.json' })
        const { onHistoryAction } = await window.editorTest.appImport<
            typeof import('../../src/history/actions')
        >('/src/history/actions.ts')
        const { decodeOperation } = await window.editorTest.appImport<
            typeof import('../../src/history/operations')
        >('/src/history/operations/index.ts')
        window.managerOperations = []
        onHistoryAction((action) => {
            if (action.kind !== 'edit') return
            const decoded = decodeOperation(action.step.operation)
            if (decoded.status !== 'known') throw new Error('Native manager emitted unknown operation')
            window.managerOperations.push(decoded.operation)
        })
    })
})

const operations = (page: Page) => page.evaluate(() => window.managerOperations)

for (const domain of ['group', 'stage'] as const) {
    test(`${domain}: overlapping folder duplication counts actual owners and preserves nested objects`, async ({ page }) => {
        const result = await page.evaluate(async (domain) => {
            const { history, appImport } = window.editorTest
            const groups = await appImport<typeof import('../../src/editor/workspace/manager/groups')>('/src/editor/workspace/manager/groups.ts')
            const stages = await appImport<typeof import('../../src/editor/workspace/manager/stages')>('/src/editor/workspace/manager/stages.ts')
            const model = domain === 'group' ? groups.groupManager : stages.stageManager
            if (model.entries().length < 2) model.add()
            const ids = model.entries().slice(0, 2).map(({ id }) => id as never)
            const folders = model.folders!
            const folder = folders.create(new Set(ids))
            const before = history.state.value
            const owners = domain === 'group' ? before.groups.size : before.stages.size
            const notes = [...before.store.slides.note.values()].flat().length
            window.managerOperations = []
            const copy = folders.duplicateMany([ids[0]!], [folder])
            const after = history.state.value
            const count = domain === 'group' ? after.groups.size : after.stages.size
            return {
                owners, count, notes,
                afterNotes: [...after.store.slides.note.values()].flat().length,
                copiedOwners: copy.entries.length,
                copiedFolders: copy.folders.length,
                copiedMembers: folders.members(copy.folders[0]!).length,
                operation: window.managerOperations[0],
            }
        }, domain)
        expect(result.copiedOwners).toBe(2)
        expect(result.copiedFolders).toBe(1)
        expect(result.copiedMembers).toBe(2)
        expect(result.count - result.owners).toBe(2)
        expect(result.afterNotes - result.notes).toBe(result.notes)
        expect(result.operation).toMatchObject({
            id: 'nse.owner.duplicate',
            data: { domain, created: { [domain]: 2, [`${domain}Folder`]: 1 } },
        })
        expect(Object.keys(result.operation!.data)).not.toContain('notes')
    })

    test(`${domain}: deletion counts removed originals while retaining a replacement baseline`, async ({ page }) => {
        const result = await page.evaluate(async (domain) => {
            const { history, appImport } = window.editorTest
            const groups = await appImport<typeof import('../../src/editor/workspace/manager/groups')>('/src/editor/workspace/manager/groups.ts')
            const stages = await appImport<typeof import('../../src/editor/workspace/manager/stages')>('/src/editor/workspace/manager/stages.ts')
            const model = domain === 'group' ? groups.groupManager : stages.stageManager
            const before = model.entries()
            window.managerOperations = []
            model.removeMany(new Set(before.map(({ id }) => id as never)))
            return {
                removed: before.length,
                remaining: model.entries().length,
                notes: [...history.state.value.store.slides.note.values()].flat().length,
                operation: window.managerOperations[0],
            }
        }, domain)
        expect(result.remaining).toBe(1)
        expect(result.notes).toBe(0)
        expect(result.operation).toMatchObject({ id: 'nse.owner.delete', data: { domain, removed: { [domain]: result.removed } } })
    })

    test(`${domain}: folder gathering, moves and ungrouping describe executed changes`, async ({ page }) => {
        const result = await page.evaluate(async (domain) => {
            const { appImport } = window.editorTest
            const groups = await appImport<typeof import('../../src/editor/workspace/manager/groups')>('/src/editor/workspace/manager/groups.ts')
            const stages = await appImport<typeof import('../../src/editor/workspace/manager/stages')>('/src/editor/workspace/manager/stages.ts')
            const model = domain === 'group' ? groups.groupManager : stages.stageManager
            if (model.entries().length < 2) model.add()
            const ids = model.entries().slice(0, 2).map(({ id }) => id as never)
            const folders = model.folders!
            window.managerOperations = []
            const folder = folders.create(new Set([ids[0]!]))
            folders.placeEntries(new Set(ids), folder)
            const joined = folders.members(folder).length
            folders.placeEntry(ids[0]!, { folder: undefined })
            const remaining = folders.members(folder).length
            folders.ungroup(folder)
            return { joined, remaining, owners: model.entries().length, operations: window.managerOperations }
        }, domain)
        expect(result.joined).toBe(2)
        expect(result.remaining).toBe(1)
        expect(result.owners).toBeGreaterThanOrEqual(2)
        expect(result.operations[0]).toMatchObject({ id: 'nse.owner.create', data: { target: { kind: `${domain}Folder` }, gathered: 1 } })
        expect(result.operations[1]).toMatchObject({ id: 'nse.owner.moveMany', data: { domain, targets: 1, destination: { kind: `${domain}Folder` } } })
        expect(result.operations[2]).toMatchObject({ id: 'nse.owner.move', data: { category: 'outOfFolder', destination: null, target: { kind: domain } } })
        expect(result.operations[3]).toMatchObject({ id: 'nse.owner.ungroup', data: { target: { kind: `${domain}Folder` }, released: 1 } })
    })
}

test('named operations retain literal historical names after later rename and delete', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const { addGroup, renameGroup, deleteGroup } = await appImport<typeof import('../../src/editor/workspace/manager/groups')>('/src/editor/workspace/manager/groups.ts')
        const id = addGroup()
        const literal = '12{1}$&<b>🎵'
        renameGroup(id, literal)
        window.managerOperations = []
        renameGroup(id, '😀'.repeat(257))
        renameGroup(id, 'Later')
        deleteGroup(id)
        return { id, literal, operations: window.managerOperations }
    })
    expect(result.operations[0]).toMatchObject({
        id: 'nse.owner.rename', data: {
            target: { kind: 'group', id: result.id, name: { text: result.literal } },
            before: { text: result.literal },
            after: { text: '😀'.repeat(256), truncated: true },
        },
    })
    expect(result.operations[2]).toMatchObject({ id: 'nse.owner.delete', data: { target: { name: { text: 'Later' } }, removed: { group: 1 } } })
})

test('Force Note Speed clear is typed absence through the real properties field', async ({ page }) => {
    await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const id = [...history.state.value.groups.keys()][0]!
        const { openGroupProperties } = await appImport<typeof import('../../src/editor/workspace/manager/groups')>('/src/editor/workspace/manager/groups.ts')
        void openGroupProperties(id)
    })
    const dialog = page.getByRole('dialog')
    const field = dialog.getByRole('spinbutton', { name: 'Force Note Speed', exact: true })
    await field.fill('8.123456789')
    await field.press('Tab')
    await expect.poll(async () => (await operations(page)).length).toBe(1)
    await field.fill('')
    await field.press('Tab')
    const captured = await operations(page)
    expect(captured.at(-1)).toMatchObject({ id: 'nse.owner.set', data: { target: { kind: 'group' }, changes: [{ field: 'forceNoteSpeed', before: 8.123456789, after: null }] } })
    expect(await page.evaluate(() => [...window.editorTest.history.state.value.groups.values()][0]!.forceNoteSpeed)).toBeUndefined()
})

test('Initial Life command and BGM dialog capture exact accepted before and after values', async ({ page }) => {
    await page.evaluate(async () => {
        const { properties } = await window.editorTest.appImport<typeof import('../../src/editor/commands/properties')>('/src/editor/commands/properties/index.ts')
        void properties.execute()
    })
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('spinbutton', { name: 'Initial Life', exact: true }).fill('999')
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    expect((await operations(page)).at(-1)).toMatchObject({ id: 'nse.header.set', data: { field: 'initialLife', before: 1000, after: 999 } })
    await page.keyboard.press('m')
    await dialog.getByRole('spinbutton', { name: 'Offset (ms)', exact: true }).fill('0.00000001')
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    expect((await operations(page)).at(-1)).toMatchObject({ id: 'nse.header.set', data: { field: 'bgmOffset', before: 0, after: 1e-11 } })
    expect(await page.evaluate(() => window.editorTest.history.state.value.bgm.offset)).toBe(1e-11)
})
