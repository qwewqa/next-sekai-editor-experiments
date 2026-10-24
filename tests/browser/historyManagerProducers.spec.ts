import { expect, test, type Page } from '@playwright/test'
import type { NativeOperation } from '../../src/history/operations'
import { confirmKeyWhenReady, confirmWhenReady } from './confirmWhenReady'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

declare global {
    interface Window {
        managerOperations: NativeOperation[]
        managerWaveforms: { created: string[]; revoked: string[] }
        managerDeleteFocusCalls: number
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
        const { onHistoryAction } =
            await window.editorTest.appImport<typeof import('../../src/history/actions')>(
                '/src/history/actions.ts',
            )
        const { decodeOperation } = await window.editorTest.appImport<
            typeof import('../../src/history/operations')
        >('/src/history/operations/index.ts')
        window.managerOperations = []
        onHistoryAction((action) => {
            if (action.kind !== 'edit') return
            const decoded = decodeOperation(action.step.operation)
            if (decoded.status !== 'known')
                throw new Error('Native manager emitted unknown operation')
            window.managerOperations.push(decoded.operation)
        })
    })
})

const operations = (page: Page) => page.evaluate(() => window.managerOperations)

const audioBytes = (sample: number) => {
    const samples = 2205
    const data = Buffer.alloc(44 + samples * 2)
    data.write('RIFF', 0)
    data.writeUInt32LE(data.length - 8, 4)
    data.write('WAVEfmt ', 8)
    data.writeUInt32LE(16, 16)
    data.writeUInt16LE(1, 20)
    data.writeUInt16LE(1, 22)
    data.writeUInt32LE(44100, 24)
    data.writeUInt32LE(88200, 28)
    data.writeUInt16LE(2, 32)
    data.writeUInt16LE(16, 34)
    data.write('data', 36)
    data.writeUInt32LE(samples * 2, 40)
    for (let index = 0; index < samples; index++)
        data.writeInt16LE(index % 2 ? sample : -sample, 44 + index * 2)
    return data.toString('base64')
}

const pickBgm = async (page: Page, sample: number) => {
    await page.evaluate(async (base64) => {
        const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0))
        const { changeBgm } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/bgm')
        >('/src/editor/commands/bgm/index.ts')
        void changeBgm(new File([bytes], 'same.wav', { type: 'audio/wav' }))
    }, audioBytes(sample))
    const dialog = page.getByRole('dialog')
    await expect(dialog).toHaveCount(1)
    await expect(dialog.locator('input[type="button"]')).toHaveValue(/\d/)
    return dialog
}

for (const domain of ['group', 'stage'] as const) {
    test(`${domain}: creation captures the actual destination and valid gathered count`, async ({
        page,
    }) => {
        const result = await page.evaluate(async (domain) => {
            const { appImport, history } = window.editorTest
            const groups = await appImport<
                typeof import('../../src/editor/workspace/manager/groups')
            >('/src/editor/workspace/manager/groups.ts')
            const stages = await appImport<
                typeof import('../../src/editor/workspace/manager/stages')
            >('/src/editor/workspace/manager/stages.ts')
            const model = domain === 'group' ? groups.groupManager : stages.stageManager
            const folders = model.folders!
            const folder = folders.create()
            const before = model.entries().length
            window.managerOperations = []
            const loose = model.add()
            const held = model.add(folder)
            const missing = model.add(Number.MAX_SAFE_INTEGER as never)
            const owners =
                domain === 'group' ? history.state.value.groups : history.state.value.stages
            return {
                added: model.entries().length - before,
                folder,
                owners: [loose, held, missing].map((id) => ({
                    id,
                    folderId: owners.get(id as never)?.folderId,
                })),
                operations: window.managerOperations,
            }
        }, domain)
        expect(result.added).toBe(3)
        expect(result.owners.map((owner) => owner?.folderId)).toEqual([
            undefined,
            result.folder,
            undefined,
        ])
        expect(result.operations).toHaveLength(3)
        for (const [index, operation] of result.operations.entries()) {
            expect(operation).toMatchObject({
                id: 'nse.owner.create',
                data: {
                    target: { kind: domain, id: result.owners[index]!.id },
                    destination:
                        index === 1 ? { kind: `${domain}Folder`, id: result.folder } : null,
                    gathered: 0,
                },
            })
        }
    })

    test(`${domain}: overlapping folder duplication counts actual owners and preserves nested objects`, async ({
        page,
    }) => {
        const result = await page.evaluate(async (domain) => {
            const { history, appImport } = window.editorTest
            const groups = await appImport<
                typeof import('../../src/editor/workspace/manager/groups')
            >('/src/editor/workspace/manager/groups.ts')
            const stages = await appImport<
                typeof import('../../src/editor/workspace/manager/stages')
            >('/src/editor/workspace/manager/stages.ts')
            const model = domain === 'group' ? groups.groupManager : stages.stageManager
            if (model.entries().length < 2) model.add()
            const ids = model
                .entries()
                .slice(0, 2)
                .map(({ id }) => id as never)
            const folders = model.folders!
            const folder = folders.create(new Set(ids))
            const before = history.state.value
            const owners = domain === 'group' ? before.groups.size : before.stages.size
            const notes = [...before.store.slides.note.values()].flat().length
            const copiedFromFolder = new Set(
                [...before.store.slides.note.values()]
                    .flat()
                    .filter((note) =>
                        ids.includes((domain === 'group' ? note.groupId : note.stageId) as never),
                    ),
            ).size
            window.managerOperations = []
            const copy = folders.duplicateMany([ids[0]!], [folder])
            const after = history.state.value
            const count = domain === 'group' ? after.groups.size : after.stages.size
            return {
                owners,
                count,
                notes,
                afterNotes: [...after.store.slides.note.values()].flat().length,
                copiedFromFolder,
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
        // The copied chart objects are recorded with the copies, and only when there are some.
        expect(result.operation!.data).toMatchObject({ objects: { note: result.copiedFromFolder } })
    })

    test(`${domain}: deletion counts removed originals while retaining a replacement baseline`, async ({
        page,
    }) => {
        const result = await page.evaluate(async (domain) => {
            const { history, appImport } = window.editorTest
            const groups = await appImport<
                typeof import('../../src/editor/workspace/manager/groups')
            >('/src/editor/workspace/manager/groups.ts')
            const stages = await appImport<
                typeof import('../../src/editor/workspace/manager/stages')
            >('/src/editor/workspace/manager/stages.ts')
            const model = domain === 'group' ? groups.groupManager : stages.stageManager
            const before = model.entries()
            const notesBefore = [...history.state.value.store.slides.note.values()].flat().length
            window.managerOperations = []
            model.removeMany(new Set(before.map(({ id }) => id as never)))
            return {
                removed: before.length,
                notesBefore,
                replacement: model.entries()[0],
                remaining: model.entries().length,
                notes: [...history.state.value.store.slides.note.values()].flat().length,
                operation: window.managerOperations[0],
            }
        }, domain)
        expect(result.remaining).toBe(1)
        expect(result.notes).toBe(0)
        expect(result.operation).toMatchObject({
            id: 'nse.owner.delete',
            data: { domain, removed: { [domain]: result.removed } },
        })
        // The notes that went with them, and the default entry made when the last one went.
        expect(result.notesBefore).toBeGreaterThan(0)
        expect(result.operation!.data).toMatchObject({
            objects: { note: result.notesBefore },
            replacement: { kind: domain, id: result.replacement!.id },
        })
    })

    test(`${domain}: folder gathering, moves and ungrouping describe executed changes`, async ({
        page,
    }) => {
        const result = await page.evaluate(async (domain) => {
            const { appImport } = window.editorTest
            const groups = await appImport<
                typeof import('../../src/editor/workspace/manager/groups')
            >('/src/editor/workspace/manager/groups.ts')
            const stages = await appImport<
                typeof import('../../src/editor/workspace/manager/stages')
            >('/src/editor/workspace/manager/stages.ts')
            const model = domain === 'group' ? groups.groupManager : stages.stageManager
            if (model.entries().length < 2) model.add()
            const ids = model
                .entries()
                .slice(0, 2)
                .map(({ id }) => id as never)
            const folders = model.folders!
            window.managerOperations = []
            const folder = folders.create(new Set([ids[0]!]))
            folders.placeEntries(new Set(ids), folder)
            const joined = folders.members(folder).length
            folders.placeEntry(ids[0]!, { folder: undefined })
            const remaining = folders.members(folder).length
            folders.ungroup(folder)
            return {
                joined,
                remaining,
                owners: model.entries().length,
                operations: window.managerOperations,
            }
        }, domain)
        expect(result.joined).toBe(2)
        expect(result.remaining).toBe(1)
        expect(result.owners).toBeGreaterThanOrEqual(2)
        expect(result.operations[0]).toMatchObject({
            id: 'nse.owner.create',
            data: { target: { kind: `${domain}Folder` }, gathered: 1 },
        })
        expect(result.operations[1]).toMatchObject({
            id: 'nse.owner.moveMany',
            data: { domain, targets: 1, destination: { kind: `${domain}Folder` } },
        })
        expect(result.operations[2]).toMatchObject({
            id: 'nse.owner.move',
            data: { category: 'outOfFolder', destination: null, target: { kind: domain } },
        })
        expect(result.operations[3]).toMatchObject({
            id: 'nse.owner.ungroup',
            data: { target: { kind: `${domain}Folder` }, released: 1 },
        })
    })
}

for (const changed of ['rename', 'reset', 'peekRoundTrip'] as const) {
    test(`a folder confirmation permanently cancels after ${changed}`, async ({ page }) => {
        const target = await page.evaluate(async () => {
            const { appImport, history } = window.editorTest
            const { groupFolderOps } = await appImport<
                typeof import('../../src/editor/workspace/manager/groups')
            >('/src/editor/workspace/manager/groups.ts')
            const id = [...history.state.value.groups.keys()][0]!
            const folder = groupFolderOps.create(new Set([id]))
            window.managerOperations = []
            void groupFolderOps.remove(folder)
            return { id, folder }
        })
        const prompt = page.getByRole('dialog')
        await expect(prompt).toBeVisible()
        const title = prompt.locator('[data-modal-title]')
        const message = prompt.locator('div.overflow-y-auto > div').first()
        const shown = { title: await title.innerText(), message: await message.innerText() }
        await page.evaluate(
            async ({ changed, id }) => {
                const { appImport, history, fixtures } = window.editorTest
                if (changed === 'rename') {
                    const { renameGroup } = await appImport<
                        typeof import('../../src/editor/workspace/manager/groups')
                    >('/src/editor/workspace/manager/groups.ts')
                    renameGroup(id as never, 'Changed while confirming')
                } else if (changed === 'reset') {
                    history.resetState(false, structuredClone(fixtures.notes), 0, {
                        sourceName: 'replacement.json',
                    })
                } else {
                    history.peek.value = { source: {}, state: history.liveState.value }
                    history.peek.value = undefined
                }
                window.managerOperations = []
            },
            { changed, id: target.id },
        )
        if (await prompt.count()) {
            await expect(title).toHaveText(shown.title)
            await expect(message).toHaveText(shown.message)
            await confirmWhenReady(
                prompt.getByRole('button', { name: 'Delete', exact: true }),
                prompt,
            )
        }
        await page.evaluate(() => window.editorTest.nextTick())
        expect(await operations(page)).toEqual([])
        expect(
            await page.evaluate(
                (id) => window.editorTest.history.state.value.groups.has(id as never),
                target.id,
            ),
        ).toBe(true)
    })
}

for (const domain of ['group', 'stage'] as const) {
    test(`${domain}: incremental properties accept own edits then close on target replacement`, async ({
        page,
    }) => {
        await page.evaluate(async (domain) => {
            const { appImport } = window.editorTest
            const groups = await appImport<
                typeof import('../../src/editor/workspace/manager/groups')
            >('/src/editor/workspace/manager/groups.ts')
            const stages = await appImport<
                typeof import('../../src/editor/workspace/manager/stages')
            >('/src/editor/workspace/manager/stages.ts')
            const model = domain === 'group' ? groups.groupManager : stages.stageManager
            void model.openProperties(model.entries()[0]!.id as never)
            window.managerOperations = []
        }, domain)
        const dialog = page.getByRole('dialog')
        const name = dialog.getByRole('textbox', { name: 'Name', exact: true })
        await name.fill('First own edit')
        await name.press('Tab')
        await name.fill('Second own edit')
        await name.press('Tab')
        await expect.poll(async () => (await operations(page)).length).toBe(2)
        await expect(dialog).toBeVisible()
        await page.evaluate(async (domain) => {
            const { appImport, history } = window.editorTest
            if (domain === 'group') {
                const { renameGroup } = await appImport<
                    typeof import('../../src/editor/workspace/manager/groups')
                >('/src/editor/workspace/manager/groups.ts')
                renameGroup([...history.state.value.groups.keys()][0]!, 'External replacement')
            } else {
                const { renameStage } = await appImport<
                    typeof import('../../src/editor/workspace/manager/stages')
                >('/src/editor/workspace/manager/stages.ts')
                renameStage([...history.state.value.stages.keys()][0]!, 'External replacement')
            }
        }, domain)
        await expect(dialog).toHaveCount(0)
        expect((await operations(page)).at(-1)).toMatchObject({
            id: 'nse.owner.rename',
            data: { after: { text: 'External replacement' } },
        })
    })
}

test('an Initial Life dialog keeps a chart edit made while it was open', async ({ page }) => {
    await page.evaluate(async () => {
        const { levelInfo } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/levelInfo')
        >('/src/editor/commands/levelInfo/index.ts')
        void levelInfo.execute()
    })
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('spinbutton', { name: 'Initial Life', exact: true }).fill('123')
    const groups = await page.evaluate(async () => {
        const { addGroup } = await window.editorTest.appImport<
            typeof import('../../src/editor/workspace/manager/groups')
        >('/src/editor/workspace/manager/groups.ts')
        addGroup()
        window.managerOperations = []
        return window.editorTest.history.liveState.value.groups.size
    })
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    // The later edit stays, and only the field the dialog changed is written over it.
    expect(await operations(page)).toHaveLength(1)
    expect((await operations(page))[0]).toMatchObject({
        id: 'nse.header.set',
        data: { field: 'initialLife', before: 1000, after: 123 },
    })
    expect(
        await page.evaluate(() => ({
            life: window.editorTest.history.state.value.initialLife,
            groups: window.editorTest.history.state.value.groups.size,
        })),
    ).toEqual({ life: 123, groups })
})

test('same-basename BGM picks remain file operations and compound changes preserve offsets', async ({
    page,
}) => {
    await (await pickBgm(page, 1000)).getByRole('button', { name: 'Confirm', exact: true }).click()
    const firstHash = await page.evaluate(
        () => window.editorTest.history.state.value.bgm.meta?.hash,
    )
    const second = await pickBgm(page, 2000)
    await second
        .getByRole('spinbutton', { name: 'Offset (ms)', exact: true })
        .fill('123.456789012345')
    await second.getByRole('button', { name: 'Confirm', exact: true }).click()
    const result = await page.evaluate(() => ({
        hash: window.editorTest.history.state.value.bgm.meta?.hash,
        filename: window.editorTest.history.state.value.bgm.filename,
        offset: window.editorTest.history.state.value.bgm.offset,
        operations: window.managerOperations,
    }))
    expect(result.hash).not.toBe(firstHash)
    expect(result.filename).toBe('same')
    expect(result.offset).toBe(0.123456789012345)
    expect(result.operations.at(-1)).toMatchObject({
        id: 'nse.bgm.change',
        data: {
            file: { before: { text: 'same' }, after: { text: 'same' } },
            offset: { before: 0, after: 0.123456789012345 },
        },
    })
    await page.keyboard.press('m')
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click()
    expect((await operations(page)).length).toBe(2)
})

test('stale BGM submits release only newly picked waveforms and keep history-owned images', async ({
    page,
}) => {
    await page.evaluate(() => {
        const created = URL.createObjectURL
        const revoked = URL.revokeObjectURL
        window.managerWaveforms = { created: [], revoked: [] }
        URL.createObjectURL = (blob) => {
            const url = created.call(URL, blob)
            if (blob instanceof Blob && blob.type === 'image/png')
                window.managerWaveforms.created.push(url)
            return url
        }
        URL.revokeObjectURL = (url) => {
            window.managerWaveforms.revoked.push(url)
            revoked.call(URL, url)
        }
    })
    await (await pickBgm(page, 1000)).getByRole('button', { name: 'Confirm', exact: true }).click()
    const opening = await page.evaluate(() => ({
        images: [...window.editorTest.history.state.value.bgm.waveform!.images],
        hash: window.editorTest.history.state.value.bgm.meta!.hash,
    }))
    expect(opening.images.length).toBeGreaterThan(0)
    const second = await pickBgm(page, 2000)
    const pending = await page.evaluate(
        (images) => window.managerWaveforms.created.filter((url) => !images.includes(url)),
        opening.images,
    )
    expect(pending.length).toBeGreaterThan(0)
    await page.evaluate(async () => {
        const { addGroup } = await window.editorTest.appImport<
            typeof import('../../src/editor/workspace/manager/groups')
        >('/src/editor/workspace/manager/groups.ts')
        addGroup()
        window.managerOperations = []
    })
    await second.getByRole('button', { name: 'Confirm', exact: true }).click()
    const result = await page.evaluate(() => ({
        revoked: window.managerWaveforms.revoked,
        hash: window.editorTest.history.state.value.bgm.meta!.hash,
        images: window.editorTest.history.state.value.bgm.waveform!.images,
        operations: window.managerOperations,
    }))
    expect(result.hash).toBe(opening.hash)
    expect(result.images).toEqual(opening.images)
    expect(result.operations).toEqual([])
    for (const url of pending) expect(result.revoked).toContain(url)
    for (const url of opening.images) expect(result.revoked).not.toContain(url)
    await page.keyboard.press('m')
    await page
        .getByRole('dialog')
        .getByRole('spinbutton', { name: 'Offset (ms)', exact: true })
        .fill('50')
    await page.evaluate(async () => {
        const { addGroup } = await window.editorTest.appImport<
            typeof import('../../src/editor/workspace/manager/groups')
        >('/src/editor/workspace/manager/groups.ts')
        addGroup()
        window.managerOperations = []
    })
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click()
    expect(await operations(page)).toEqual([])
    for (const url of opening.images)
        expect(await page.evaluate(() => window.managerWaveforms.revoked)).not.toContain(url)
})

test('bulk Delete cannot remove a selection changed while its confirmation is open', async ({
    page,
}) => {
    await page.evaluate(() => {
        window.editorTest.settings.showGroups = true
    })
    const panel = page.locator('#workspace-panel-groups')
    const names = panel.locator('.manager-entry .manager-name')
    await names.nth(0).click({ modifiers: ['ControlOrMeta'] })
    await names.nth(1).click({ modifiers: ['ControlOrMeta'] })
    await panel.locator('.manager-bulk-delete').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const before = await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const id = [...history.state.value.groups.keys()][0]!
        const { renameGroup } = await appImport<
            typeof import('../../src/editor/workspace/manager/groups')
        >('/src/editor/workspace/manager/groups.ts')
        renameGroup(id, 'Changed while confirming')
        window.managerOperations = []
        return [...history.state.value.groups.keys()]
    })
    await confirmWhenReady(dialog.getByRole('button', { name: 'Delete', exact: true }), dialog)
    expect(
        await page.evaluate(() => [...window.editorTest.history.state.value.groups.keys()]),
    ).toEqual(before)
    expect(await operations(page)).toEqual([])
})

test('Initial Life still opens read-only while peeking and cannot commit its dialog', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        history.peek.value = { source: {}, state: history.liveState.value }
        const { levelInfo } = await appImport<typeof import('../../src/editor/commands/levelInfo')>(
            '/src/editor/commands/levelInfo/index.ts',
        )
        void levelInfo.execute()
    })
    const dialog = page.getByRole('dialog')
    await expect(
        dialog.getByRole('spinbutton', { name: 'Initial Life', exact: true }),
    ).toBeDisabled()
    // Read-only, its footer button is OK, which only closes it.
    await expect(dialog.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'OK', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(await operations(page)).toEqual([])
    expect(await page.evaluate(() => window.editorTest.history.liveState.value.initialLife)).toBe(
        1000,
    )
})

test('a missing folder removal returns false without changing chart state or recording an action', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const { groupFolderOps } = await appImport<
            typeof import('../../src/editor/workspace/manager/groups')
        >('/src/editor/workspace/manager/groups.ts')
        const { stageFolderOps } = await appImport<
            typeof import('../../src/editor/workspace/manager/stages')
        >('/src/editor/workspace/manager/stages.ts')
        const before = history.liveState.value
        const missing = 999999 as never
        return {
            group: await groupFolderOps.remove(missing),
            stage: await stageFolderOps.remove(missing),
            unchanged: before === history.liveState.value,
            operations: window.managerOperations,
        }
    })
    expect(result).toEqual({ group: false, stage: false, unchanged: true, operations: [] })
    await expect(page.getByRole('dialog')).toHaveCount(0)
})

for (const outcome of ['cancel', 'reset', 'membershipChanged'] as const) {
    test(`keyboard folder removal ${outcome} does not refocus a manager row or delete unconfirmed owners`, async ({
        page,
    }) => {
        const member = await page.evaluate(async () => {
            const { history, appImport, settings } = window.editorTest
            const { groupFolderOps } = await appImport<
                typeof import('../../src/editor/workspace/manager/groups')
            >('/src/editor/workspace/manager/groups.ts')
            const id = [...history.liveState.value.groups.keys()][0]!
            groupFolderOps.create(new Set([id]))
            settings.showGroups = true
            return id
        })
        const more = page.locator('#workspace-panel-groups .manager-folder-row .manager-more')
        await more.focus()
        await page.keyboard.press('Enter')
        await page.getByRole('menuitem', { name: /^Delete/ }).focus()
        await page.keyboard.press('Enter')
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()
        const before = await page.evaluate(
            async ({ outcome, member }) => {
                const { history, fixtures, appImport, nextTick } = window.editorTest
                if (outcome === 'reset') {
                    history.resetState(false, structuredClone(fixtures.notes), 0, {
                        sourceName: 'replacement.json',
                    })
                } else if (outcome === 'membershipChanged') {
                    const { groupFolderOps } = await appImport<
                        typeof import('../../src/editor/workspace/manager/groups')
                    >('/src/editor/workspace/manager/groups.ts')
                    const folder = [...history.liveState.value.groupFolders.keys()][0]!
                    const newcomer = [...history.liveState.value.groups.keys()].find(
                        (id) => id !== member,
                    )!
                    groupFolderOps.placeEntry(member as never, { folder: undefined })
                    groupFolderOps.placeEntry(newcomer, { folder })
                }
                await nextTick()
                const focus = HTMLElement.prototype.focus
                window.managerDeleteFocusCalls = 0
                HTMLElement.prototype.focus = function (
                    this: HTMLElement,
                    ...args: Parameters<HTMLElement['focus']>
                ) {
                    if (
                        this.matches(
                            '#workspace-panel-groups .manager-more, #workspace-panel-groups .manager-name',
                        )
                    )
                        window.managerDeleteFocusCalls++
                    focus.apply(this, args)
                }
                window.managerOperations = []
                return {
                    owners: [...history.liveState.value.groups.keys()],
                    notes: [...history.liveState.value.store.slides.note.values()].flat().length,
                }
            },
            { outcome, member },
        )
        await dialog
            .getByRole('button', { name: outcome === 'cancel' ? 'Cancel' : 'Delete', exact: true })
            .focus()
        await confirmKeyWhenReady(page, 'Enter', dialog)
        await expect(dialog).toHaveCount(0)
        await page.evaluate(() => window.editorTest.nextTick())
        expect(
            await page.evaluate(() => ({
                owners: [...window.editorTest.history.liveState.value.groups.keys()],
                notes: [
                    ...window.editorTest.history.liveState.value.store.slides.note.values(),
                ].flat().length,
                operations: window.managerOperations,
                focusCalls: window.managerDeleteFocusCalls,
            })),
        ).toEqual({ ...before, operations: [], focusCalls: 0 })
    })
}

test('named operations retain literal historical names after later rename and delete', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const { addGroup, renameGroup, deleteGroup } = await appImport<
            typeof import('../../src/editor/workspace/manager/groups')
        >('/src/editor/workspace/manager/groups.ts')
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
        id: 'nse.owner.rename',
        data: {
            target: { kind: 'group', id: result.id, name: { text: result.literal } },
            before: { text: result.literal },
            after: { text: '😀'.repeat(256), truncated: true },
        },
    })
    expect(result.operations[2]).toMatchObject({
        id: 'nse.owner.delete',
        data: { target: { name: { text: 'Later' } }, removed: { group: 1 } },
    })
})

test('Force Note Speed clear is typed absence through the real properties field', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const id = [...history.state.value.groups.keys()][0]!
        const { openGroupProperties } = await appImport<
            typeof import('../../src/editor/workspace/manager/groups')
        >('/src/editor/workspace/manager/groups.ts')
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
    expect(captured.at(-1)).toMatchObject({
        id: 'nse.owner.set',
        data: {
            target: { kind: 'group' },
            changes: [{ field: 'forceNoteSpeed', before: 8.123456789, after: null }],
        },
    })
    expect(
        await page.evaluate(
            () => [...window.editorTest.history.state.value.groups.values()][0]!.forceNoteSpeed,
        ),
    ).toBeUndefined()
})

test('Initial Life command and BGM dialog capture exact accepted before and after values', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { levelInfo } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/levelInfo')
        >('/src/editor/commands/levelInfo/index.ts')
        void levelInfo.execute()
    })
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('spinbutton', { name: 'Initial Life', exact: true }).fill('999')
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    expect((await operations(page)).at(-1)).toMatchObject({
        id: 'nse.header.set',
        data: { field: 'initialLife', before: 1000, after: 999 },
    })
    expect(await page.evaluate(() => window.editorTest.history.state.value.initialLife)).toBe(999)
    await page.keyboard.press('m')
    await dialog.getByRole('spinbutton', { name: 'Offset (ms)', exact: true }).fill('0.00000001')
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    expect((await operations(page)).at(-1)).toMatchObject({
        id: 'nse.header.set',
        data: { field: 'bgmOffset', before: 0, after: 1e-11 },
    })
    expect(await page.evaluate(() => window.editorTest.history.state.value.bgm.offset)).toBe(1e-11)
})

for (const domain of ['group', 'stage'] as const) {
    test(`${domain}: confirmed folder deletion removes only its owners and records folder scope`, async ({
        page,
    }) => {
        const before = await page.evaluate(async (domain) => {
            const { appImport } = window.editorTest
            const groups = await appImport<
                typeof import('../../src/editor/workspace/manager/groups')
            >('/src/editor/workspace/manager/groups.ts')
            const stages = await appImport<
                typeof import('../../src/editor/workspace/manager/stages')
            >('/src/editor/workspace/manager/stages.ts')
            const model = domain === 'group' ? groups.groupManager : stages.stageManager
            const ids = model.entries().map(({ id }) => id as never)
            const folder = model.folders.create(new Set(ids))
            window.managerOperations = []
            void model.folders.remove(folder)
            return { folder, owners: ids.length }
        }, domain)
        await confirmWhenReady(
            page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }),
            page.getByRole('dialog'),
        )
        await expect.poll(async () => (await operations(page)).length).toBe(1)
        expect((await operations(page))[0]).toMatchObject({
            id: 'nse.owner.delete',
            data: {
                domain,
                target: { kind: `${domain}Folder`, id: before.folder },
                removed: { [domain]: before.owners, [`${domain}Folder`]: 1 },
            },
        })
        expect(
            await page.evaluate((domain) => {
                const state = window.editorTest.history.state.value
                return {
                    owners: domain === 'group' ? state.groups.size : state.stages.size,
                    folders: domain === 'group' ? state.groupFolders.size : state.stageFolders.size,
                    notes: [...state.store.slides.note.values()].flat().length,
                }
            }, domain),
        ).toEqual({ owners: 1, folders: 0, notes: 0 })
    })
}

// The cascades: what an entry owns goes and comes with it, and Step Details lists exactly that.
// The chart has two of everything, each group holding half of the time scales, and stage 1 all
// of the stage events (the fixture puts them there). Counts come from the chart's own entities
// before and after, so the recorded objects are checked against what really left or arrived.

type Counts = Record<string, number>

const loadEvents = (page: Page) =>
    page.evaluate(() => {
        const { history, fixtures } = window.editorTest
        history.resetState(false, structuredClone(fixtures.events), 0, {
            sourceName: 'manager-cascades.json',
        })
        window.managerOperations = []
    })

/** The state's native entities by kind: remembered ('before'), or compared with what was. */
const nativeCounts = (page: Page, which: 'before' | 'gone' | 'added') =>
    page.evaluate(async (which) => {
        const { history, appImport } = window.editorTest
        const receipts = await appImport<
            typeof import('../../src/state/operations/historyReceipts')
        >('/src/state/operations/historyReceipts.ts')
        const types = [
            'bpm',
            'timeScale',
            'cameraEventJoint',
            'stageMaskEventJoint',
            'stagePivotEventJoint',
            'stageStyleEventJoint',
            'stageTransformEventJoint',
        ] as const
        const all = (state: typeof history.state.value) => {
            const found = new Set<object>()
            for (const notes of state.store.slides.note.values())
                for (const note of notes) found.add(note)
            for (const type of types)
                for (const bucket of state.store.grid[type].values())
                    for (const entity of bucket) found.add(entity)
            return found
        }
        const remembered = window as unknown as { cascadeBefore?: Set<object> }
        if (which === 'before') {
            remembered.cascadeBefore = all(history.state.value)
            return {}
        }
        const now = all(history.state.value)
        const before = remembered.cascadeBefore!
        const entities =
            which === 'gone'
                ? [...before].filter((entity) => !now.has(entity))
                : [...now].filter((entity) => !before.has(entity))
        return { ...receipts.countNativeEntities(entities as never) } as Record<string, number>
    }, which)

const stageEvents = {
    stageMaskEvent: 4,
    stagePivotEvent: 4,
    stageStyleEvent: 4,
    stageTransformEvent: 4,
}

test('group deletion records its notes and time scales, and nothing it did not own', async ({
    page,
}) => {
    await loadEvents(page)
    await nativeCounts(page, 'before')
    await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const { groupManager } = await appImport<
            typeof import('../../src/editor/workspace/manager/groups')
        >('/src/editor/workspace/manager/groups.ts')
        groupManager.removeMany(new Set([1 as never]))
    })
    const gone: Counts = await nativeCounts(page, 'gone')
    expect(gone).toEqual({ note: 2, timeScale: 2 })
    const [operation] = await operations(page)
    expect(operation).toMatchObject({
        id: 'nse.owner.delete',
        data: { domain: 'group', removed: { group: 1 } },
    })
    expect(operation!.data).toHaveProperty('objects', gone)
})

test('stage deletion records its notes and stage events, and no camera event', async ({ page }) => {
    await loadEvents(page)
    await nativeCounts(page, 'before')
    await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const { stageManager } = await appImport<
            typeof import('../../src/editor/workspace/manager/stages')
        >('/src/editor/workspace/manager/stages.ts')
        stageManager.removeMany(new Set([1 as never]))
    })
    const gone: Counts = await nativeCounts(page, 'gone')
    expect(gone).toEqual({ note: 2, ...stageEvents })
    const [operation] = await operations(page)
    expect(operation).toMatchObject({
        id: 'nse.owner.delete',
        data: { domain: 'stage', removed: { stage: 1 } },
    })
    expect(operation!.data).toHaveProperty('objects', gone)
})

for (const domain of ['group', 'stage'] as const) {
    test(`${domain}: deleting a folder with members records every member's objects`, async ({
        page,
    }) => {
        await loadEvents(page)
        await page.evaluate(async (domain) => {
            const { appImport } = window.editorTest
            const groups = await appImport<
                typeof import('../../src/editor/workspace/manager/groups')
            >('/src/editor/workspace/manager/groups.ts')
            const stages = await appImport<
                typeof import('../../src/editor/workspace/manager/stages')
            >('/src/editor/workspace/manager/stages.ts')
            const model = domain === 'group' ? groups.groupManager : stages.stageManager
            const ids = model.entries().map(({ id }) => id as never)
            const folder = model.folders.create(new Set(ids))
            window.managerOperations = []
            ;(window as unknown as { cascadeFolder: number }).cascadeFolder = folder
        }, domain)
        await nativeCounts(page, 'before')
        await page.evaluate(async (domain) => {
            const { appImport } = window.editorTest
            const groups = await appImport<
                typeof import('../../src/editor/workspace/manager/groups')
            >('/src/editor/workspace/manager/groups.ts')
            const stages = await appImport<
                typeof import('../../src/editor/workspace/manager/stages')
            >('/src/editor/workspace/manager/stages.ts')
            const model = domain === 'group' ? groups.groupManager : stages.stageManager
            void model.folders.remove(
                (window as unknown as { cascadeFolder: number }).cascadeFolder as never,
            )
        }, domain)
        await confirmWhenReady(
            page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }),
            page.getByRole('dialog'),
        )
        await expect.poll(async () => (await operations(page)).length).toBe(1)
        const gone: Counts = await nativeCounts(page, 'gone')
        expect(gone).toEqual(
            domain === 'group' ? { note: 2, timeScale: 4 } : { note: 2, ...stageEvents },
        )
        const [operation] = await operations(page)
        expect(operation).toMatchObject({
            id: 'nse.owner.delete',
            data: { domain, removed: { [domain]: 2, [`${domain}Folder`]: 1 } },
        })
        expect(operation!.data).toHaveProperty('objects', gone)
    })

    test(`${domain}: duplicating an entry records the copies of everything it owns`, async ({
        page,
    }) => {
        await loadEvents(page)
        await nativeCounts(page, 'before')
        await page.evaluate(async (domain) => {
            const { appImport } = window.editorTest
            const groups = await appImport<
                typeof import('../../src/editor/workspace/manager/groups')
            >('/src/editor/workspace/manager/groups.ts')
            const stages = await appImport<
                typeof import('../../src/editor/workspace/manager/stages')
            >('/src/editor/workspace/manager/stages.ts')
            const model = domain === 'group' ? groups.groupManager : stages.stageManager
            model.folders.duplicateMany([1 as never], [])
        }, domain)
        const added: Counts = await nativeCounts(page, 'added')
        expect(added).toEqual(
            domain === 'group' ? { note: 2, timeScale: 2 } : { note: 2, ...stageEvents },
        )
        const [operation] = await operations(page)
        expect(operation).toMatchObject({
            id: 'nse.owner.duplicate',
            data: { domain, created: { [domain]: 1 } },
        })
        expect(operation!.data).toHaveProperty('objects', added)
    })
}

// The owner operations only the manager's Vue-bound producers make are run here, so the
// completeness test in tests/editor/historyProducerReceipts.test.ts names this test for them.
test('every owner operation id comes out of a manager producer, known and decoded', async ({
    page,
}) => {
    await loadEvents(page)
    const result = await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const groups = await appImport<typeof import('../../src/editor/workspace/manager/groups')>(
            '/src/editor/workspace/manager/groups.ts',
        )
        const { operationCodecs } = await appImport<typeof import('../../src/history/operations')>(
            '/src/history/operations/index.ts',
        )
        const model = groups.groupManager
        const ids = model.entries().map(({ id }) => id as never)
        window.managerOperations = []
        model.add()
        const folder = model.folders.create(new Set([ids[0]!]))
        model.folders.placeEntries(new Set(ids), folder)
        model.folders.placeEntry(ids[0]!, { folder: undefined })
        model.folders.ungroup(folder)
        model.removeMany(new Set([ids[1]!]))
        return {
            produced: window.managerOperations.map((operation) => operation.id),
            owner: Object.keys(operationCodecs).filter((id) => id.startsWith('nse.owner.')),
        }
    })
    const produced = new Set<string>(result.produced)
    for (const id of [
        'nse.owner.create',
        'nse.owner.move',
        'nse.owner.moveMany',
        'nse.owner.delete',
        'nse.owner.ungroup',
    ])
        expect(produced, id).toContain(id)
    // A new owner operation must be produced here, or covered by a unit receipt.
    const unit = ['nse.owner.rename', 'nse.owner.set', 'nse.owner.duplicate']
    expect(result.owner.filter((id) => !produced.has(id) && !unit.includes(id))).toEqual([])
})

test('renaming to the same name pushes no step, for a group, a stage and their folders', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const groupsModule = await appImport<
            typeof import('../../src/editor/workspace/manager/groups')
        >('/src/editor/workspace/manager/groups.ts')
        const stagesModule = await appImport<
            typeof import('../../src/editor/workspace/manager/stages')
        >('/src/editor/workspace/manager/stages.ts')
        const groupId = [...history.state.value.groups.keys()][0]!
        const stageId = [...history.state.value.stages.keys()][0]!
        const groupFolder = groupsModule.groupFolderOps.create(new Set([groupId]))
        const stageFolder = stagesModule.stageFolderOps.create(new Set([stageId]))
        window.managerOperations = []
        const live = history.state.value
        const sameOf = () => history.state.value === live
        const name = (id: number) => history.state.value.groups.get(id as never)!.name
        groupsModule.renameGroup(groupId, name(groupId))
        groupsModule.renameGroup(groupId, `  ${name(groupId)}  `)
        stagesModule.renameStage(stageId, history.state.value.stages.get(stageId)!.name)
        groupsModule.groupFolderOps.rename(
            groupFolder,
            groupsModule.groupFolderOps.name(groupFolder),
        )
        stagesModule.stageFolderOps.rename(
            stageFolder,
            stagesModule.stageFolderOps.name(stageFolder),
        )
        const unchanged = { sameOf: sameOf(), count: window.managerOperations.length }
        // A sentinel: a real rename is recorded, so the checks above could have recorded one.
        groupsModule.renameGroup(groupId, 'Renamed')
        return { unchanged, after: window.managerOperations.length }
    })
    expect(result.unchanged).toEqual({ sameOf: true, count: 0 })
    expect(result.after).toBe(1)
})

test('confirming the Group or Stage Properties dialog with no change pushes no step', async ({
    page,
}) => {
    const open = (kind: 'group' | 'stage') =>
        page.evaluate(async (kind) => {
            const { appImport, history } = window.editorTest
            const { showModal } =
                await appImport<typeof import('../../src/modals')>('/src/modals/index.ts')
            const group = kind === 'group'
            const { default: Modal } = group
                ? await appImport<{ default: never }>(
                      '/src/editor/commands/manageGroups/manageGroups/groupProperties/GroupPropertiesModal.vue',
                  )
                : await appImport<{ default: never }>(
                      '/src/editor/commands/manageStages/manageStages/stageProperties/StagePropertiesModal.vue',
                  )
            window.managerOperations = []
            const ids = [
                ...(group ? history.state.value.groups : history.state.value.stages).keys(),
            ]
            void showModal(
                Modal as never,
                (group ? { groupId: ids[0] } : { stageId: ids[0] }) as never,
            )
        }, kind)
    await open('group')
    const dialog = page.locator('dialog[open]')
    const name = dialog.getByRole('textbox', { name: 'Name', exact: true })
    const speed = dialog.getByRole('spinbutton')
    await speed.fill('9')
    await page.keyboard.press('Enter')
    await expect.poll(() => operations(page).then((list) => list.length)).toBe(1)
    // The same name and the same speed again, confirmed.
    await name.focus()
    await page.keyboard.press('Enter')
    await speed.fill('9')
    await page.keyboard.press('Enter')
    await expect(speed).not.toBeFocused()
    expect(await operations(page)).toHaveLength(1)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await open('stage')
    const stageName = dialog.getByRole('textbox', { name: 'Name', exact: true })
    await stageName.focus()
    await page.keyboard.press('Enter')
    await expect(stageName).not.toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(await operations(page)).toEqual([])
    // A sentinel after the checks: a real change in the stage dialog is recorded.
    await open('stage')
    await stageName.fill('Changed')
    await page.keyboard.press('Enter')
    await expect.poll(() => operations(page).then((list) => list.length)).toBe(1)
})
