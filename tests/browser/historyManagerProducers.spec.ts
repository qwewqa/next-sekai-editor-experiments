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
            window.managerOperations = []
            const copy = folders.duplicateMany([ids[0]!], [folder])
            const after = history.state.value
            const count = domain === 'group' ? after.groups.size : after.stages.size
            return {
                owners,
                count,
                notes,
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
        expect(result.operation).toMatchObject({
            id: 'nse.owner.delete',
            data: { domain, removed: { [domain]: result.removed } },
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
            await prompt.getByRole('button', { name: 'Delete', exact: true }).click()
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

test('an Initial Life dialog cannot overwrite a later chart edit', async ({ page }) => {
    await page.evaluate(async () => {
        const { properties } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/properties')
        >('/src/editor/commands/properties/index.ts')
        void properties.execute()
    })
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('spinbutton', { name: 'Initial Life', exact: true }).fill('123')
    await page.evaluate(async () => {
        const { addGroup } = await window.editorTest.appImport<
            typeof import('../../src/editor/workspace/manager/groups')
        >('/src/editor/workspace/manager/groups.ts')
        addGroup()
        window.managerOperations = []
    })
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    expect(await operations(page)).toEqual([])
    expect(await page.evaluate(() => window.editorTest.history.state.value.initialLife)).toBe(1000)
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
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
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
        const { properties } = await appImport<
            typeof import('../../src/editor/commands/properties')
        >('/src/editor/commands/properties/index.ts')
        void properties.execute()
    })
    const dialog = page.getByRole('dialog')
    await expect(
        dialog.getByRole('spinbutton', { name: 'Initial Life', exact: true }),
    ).toBeDisabled()
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
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
        const { properties } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/properties')
        >('/src/editor/commands/properties/index.ts')
        void properties.execute()
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
