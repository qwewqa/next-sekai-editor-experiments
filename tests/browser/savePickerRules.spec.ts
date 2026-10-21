import { expect, test, type Page } from '@playwright/test'
import { executePlan, planNxsp } from '../../src/local/nxsp'
import { fresh } from '../local/nxsp/chain'
import { crafted } from '../local/nxsp/craft'
import { installTestPlatform, waitForStartup } from './editorFixture'
import {
    chainById,
    chainOf,
    edit,
    flushed,
    notice,
    pauseAt,
    pressSave,
    projectOf,
    prompts,
    queuePicks,
    reached,
    readFile,
    release,
    saveDialog,
    sessionOf,
    start,
    submitSave,
    writeFile,
} from './saveFlows'

// The save picker's rules where the Step 6 reviews found gaps (Part 1 §1.4.7 R2–R11; owner
// decision log D5, D26; `work/step6/review/dataloss.md`): what a taken-over tab shows and asks,
// the pre-bind, the version on disk kept through Save as a Separate File, the kept bytes of a
// partial open after a reload, Export's picker, and failures that must leave the next Save able.

type Row = Record<string, unknown>

const savedTo = async (page: Page, name: string) => {
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, name.replace(/\.nxsp$/, ''))
    await expect(notice(page).filter({ hasText: `Saved to ${name}` })).toBeVisible()
    await expect.poll(async () => (await chainOf(page)).file).toMatchObject({ name })
}

/** A dialog ignores presses in its first moments (§1.4.1). */
const afterGuard = (page: Page) => page.waitForTimeout(400)

const freshBytes = async () =>
    new Uint8Array(await (await executePlan(planNxsp(fresh().input).plan, new Map())).arrayBuffer())

/** Rewrites an OPFS `.nxsp` as another version of it: the same length, another central directory. */
const changeOnDisk = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        const file = await (await root.getFileHandle(name)).getFile()
        const bytes = new Uint8Array(await file.arrayBuffer())
        for (let i = 0; i + 4 < bytes.length; i++)
            if (
                bytes[i] === 0x50 &&
                bytes[i + 1] === 0x4b &&
                bytes[i + 2] === 1 &&
                bytes[i + 3] === 2
            ) {
                bytes[i + 4] = bytes[i + 4]! ^ 1
                break
            }
        const writable = await (await root.getFileHandle(name)).createWritable()
        await writable.write(bytes)
        await writable.close()
    }, name)

/** Wraps the platform's file writes of one kind with a failure, as a full disk would. */
const failWrites = (page: Page, kind: string) =>
    page.evaluate(async (kind) => {
        const module =
            (await import('/src/platform/index.ts')) as typeof import('../../src/platform')
        const own = module.platform
        module.setPlatformForTests({
            ...own,
            saveFile: (req) =>
                req.kind === kind
                    ? Promise.reject(new DOMException('Disk full', 'QuotaExceededError'))
                    : own.saveFile(req),
        })
    }, kind)

test('an unedited tab whose file is taken over shows it, and prompts on close', async ({
    context,
}) => {
    const b = await context.newPage()
    await start(b)
    await writeFile(b, 'coconut.nxsp', await freshBytes())
    await queuePicks(b, ['coconut.nxsp'])
    await b.keyboard.press('o')
    await expect(notice(b).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    await expect.poll(async () => (await sessionOf(b)).file?.name).toBe('coconut.nxsp')
    expect(await prompts(b)).toBe(false)

    const a = await context.newPage()
    await start(a)
    await edit(a, 5)
    await queuePicks(a, ['coconut.nxsp'])
    await pressSave(a)
    await submitSave(a)
    await expect(
        notice(a).filter({ hasText: 'Its earlier work is in Recent Sessions.' }),
    ).toBeVisible()

    await b.bringToFront()
    await expect.poll(async () => (await sessionOf(b)).file).toBeUndefined()
    // Its old content is now only in storage (R6).
    expect(await prompts(b)).toBe(true)
})

test('with storing paused, a revocation kept in localStorage reaches the owner’s open tab', async ({
    context,
}) => {
    const b = await context.newPage()
    await start(b)
    await savedTo(b, 'coconut.nxsp')
    await b.evaluate(() => window.nseFlushTest!.flusher.flush({ strict: true }))

    const a = await context.newPage()
    await a.addInitScript(() => {
        sessionStorage.setItem('nse.test.storage', JSON.stringify({ forceQuota: true }))
    })
    await start(a)
    await edit(a, 5)
    await queuePicks(a, ['coconut.nxsp'])
    await pressSave(a)
    await submitSave(a)
    await expect(notice(a).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()

    // R11: B's record still names the file, but B's label goes and B prompts, before any reload.
    await b.bringToFront()
    await expect.poll(async () => (await sessionOf(b)).file).toBeUndefined()
    expect(await prompts(b)).toBe(true)
})

test('a write-back that finds itself revoked opens the Save dialog with the reason', async ({
    context,
}) => {
    const b = await context.newPage()
    // B hears no broadcast, and isn't shown again: nothing tells it before its Save.
    await b.addInitScript(() => {
        window.BroadcastChannel = class {
            postMessage() {}
            addEventListener() {}
            close() {}
        } as unknown as typeof BroadcastChannel
    })
    await start(b)
    await savedTo(b, 'coconut.nxsp')

    const a = await context.newPage()
    await start(a)
    await edit(a, 5)
    await queuePicks(a, ['coconut.nxsp'])
    await pressSave(a)
    await submitSave(a)
    await expect(
        notice(a).filter({ hasText: 'Its earlier work is in Recent Sessions.' }),
    ).toBeVisible()

    // B's Save finds the revocation under nse-bind (R10), and says why it asks.
    expect((await sessionOf(b)).file?.name).toBe('coconut.nxsp')
    await edit(b, 3)
    await pressSave(b)
    await expect(saveDialog(b)).toContainText(
        '"coconut.nxsp" was replaced from another tab or window.',
    )
    await expect.poll(async () => (await sessionOf(b)).file).toBeUndefined()
})

test('a pre-bind shows at once, ends a revocation, and carries Save As…’s new docId', async ({
    context,
}) => {
    const b = await context.newPage()
    await start(b)
    await savedTo(b, 'coconut.nxsp')
    const bChain = await chainOf(b)
    const a = await context.newPage()
    await start(a)
    await edit(a, 5)
    await queuePicks(a, ['coconut.nxsp'])
    await pressSave(a)
    await submitSave(a)
    await expect(
        notice(a).filter({ hasText: 'Its earlier work is in Recent Sessions.' }),
    ).toBeVisible()

    // B, revoked, saves to a new file: paused before the write, it's bound to it already.
    await b.bringToFront()
    await expect.poll(async () => (await sessionOf(b)).file).toBeUndefined()
    await edit(b, 3)
    await pauseAt(b, 'revoked')
    await pressSave(b)
    await submitSave(b)
    await reached(b, 'revoked')
    expect((await sessionOf(b)).file?.name).toBe('coconut (2).nxsp')
    const preBound = (await chainById(b, bChain.chainId))!
    expect(preBound.replaced).toBeUndefined()
    expect(preBound.docId).toBe(bChain.docId)
    await release(b)
    await expect(notice(b).filter({ hasText: 'Saved to coconut (2).nxsp' })).toBeVisible()

    // Save As… gives its new docId with the pre-bind, and no revision yet.
    await b.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs)
    })
    await pauseAt(b, 'revoked')
    await submitSave(b, 'melt', 'Save As')
    await expect
        .poll(() =>
            b.evaluate(() => window.nseSaveTest?.reached.filter((at) => at === 'revoked').length),
        )
        .toBe(2)
    const saveAs = (await chainById(b, bChain.chainId))!
    expect(saveAs.docId).not.toBe(bChain.docId)
    expect(saveAs.revision).toBeUndefined()
    expect((saveAs.file as Row).name).toBe('melt.nxsp')
    await release(b)
    await expect(notice(b).filter({ hasText: 'Saved to melt.nxsp' })).toBeVisible()
    expect((await projectOf(b, 'melt.nxsp')).id).toBe(saveAs.docId)
})

test('Save as a Separate File picking the chain’s own changed file puts that version back', async ({
    page,
}) => {
    await start(page)
    await savedTo(page, 'coconut.nxsp')
    await changeOnDisk(page, 'coconut.nxsp')
    const changed = await readFile(page, 'coconut.nxsp')
    await edit(page, 2)
    await pressSave(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('"coconut.nxsp" Changed')
    await afterGuard(page)
    await queuePicks(page, ['coconut.nxsp'])
    await dialog.getByRole('button', { name: 'Save as a Separate File' }).click()
    // The version on disk is back, and the dialog asks again.
    await expect(page.getByRole('dialog')).toContainText('"coconut.nxsp" Changed')
    expect(await readFile(page, 'coconut.nxsp')).toEqual(changed)
})

test('a version on disk that cannot be put back is offered as a download', async ({ page }) => {
    await start(page)
    await savedTo(page, 'coconut.nxsp')
    await changeOnDisk(page, 'coconut.nxsp')
    await edit(page, 2)
    await pressSave(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('"coconut.nxsp" Changed')
    await failWrites(page, 'recovery')
    await afterGuard(page)
    await queuePicks(page, ['coconut.nxsp'])
    await dialog.getByRole('button', { name: 'Save as a Separate File' }).click()
    const offer = page.getByRole('dialog').filter({ hasText: 'could not be restored' })
    await expect(offer).toContainText('"coconut.nxsp" was emptied')
    await expect(offer.getByRole('button', { name: 'Download' })).toBeVisible()
})

for (const lifecycle of ['reload', 'reload gap', 'switch and reopen']) {
    test(`a partial original survives ${lifecycle} and is restored after the picker`, async ({
        page,
        context,
    }) => {
        const other = lifecycle === 'reload gap' ? await context.newPage() : undefined
        if (other) {
            await other.addInitScript(() => {
                const idle = window.requestIdleCallback
                window.requestIdleCallback = (callback, options) => {
                    if (callback.name !== 'sweep') return idle(callback, options)
                    callback({ didTimeout: false, timeRemaining: () => 50 })
                    return 0
                }
            })
            await start(other)
            await edit(other, 9)
            await flushed(other)
        }
        await start(page)
        const file = await crafted((items) => {
            items.push({ name: 'video/clip.mp4', data: new Uint8Array([1, 2, 3]), method: 'store' })
        })
        const bytes = [...new Uint8Array(await file.arrayBuffer())]
        await writeFile(page, 'coconut.nxsp', bytes)
        await queuePicks(page, ['coconut.nxsp'])
        await page.keyboard.press('o')
        await expect(notice(page).filter({ hasText: 'Made by a newer version' })).toBeVisible()
        await edit(page, 3)
        await flushed(page)
        if (lifecycle === 'switch and reopen') {
            const originalDoc = (await sessionOf(page)).docId
            await page.keyboard.press('n')
            await expect(notice(page).filter({ hasText: 'New level' })).toBeVisible()
            await page.getByRole('button', { name: /^Reopen / }).click()
            await expect.poll(async () => (await sessionOf(page)).docId).toBe(originalDoc)
            await edit(page, 3.5)
            await flushed(page)
        }
        const opened = (await sessionOf(page)).sessionId
        if (other) {
            await page.goto('about:blank')
            await other.reload()
            await waitForStartup(other)
            expect(
                await other.evaluate(
                    async (id) =>
                        (await navigator.locks.query()).held?.some(
                            (lock) => lock.name === `nse-session:${id}`,
                        ),
                    opened,
                ),
            ).toBe(false)
            await page.goto('/')
        } else await page.reload()
        await waitForStartup(page)
        expect((await sessionOf(page)).sessionId).toBe(opened)
        await edit(page, 4)
        await queuePicks(page, ['coconut.nxsp'])
        await pressSave(page)
        await submitSave(page)
        await expect(page.getByRole('dialog')).toContainText(
            'Not saved. "coconut.nxsp" could not be read completely.',
        )
        expect(await readFile(page, 'coconut.nxsp')).toEqual(bytes)
    })
}

test('a takeover that localStorage refuses outside safe mode says the file was not written', async ({
    context,
}) => {
    const b = await context.newPage()
    await start(b)
    await savedTo(b, 'coconut.nxsp')
    const a = await context.newPage()
    await a.addInitScript(() => {
        sessionStorage.setItem('nse.test.storage', JSON.stringify({ forceQuota: true }))
        const setItem = Storage.prototype.setItem
        Storage.prototype.setItem = function (key, value) {
            if (key.includes('.revoke.')) throw new DOMException('Full', 'QuotaExceededError')
            setItem.call(this, key, value)
        }
    })
    await start(a)
    await edit(a, 5)
    await queuePicks(a, ['coconut.nxsp'])
    await pressSave(a)
    await submitSave(a)
    const dialog = a.getByRole('dialog')
    await expect(dialog).toContainText('"coconut.nxsp" could not be written.')
    await expect(dialog).not.toContainText('safe mode')
    expect((await chainOf(b)).file).toMatchObject({ name: 'coconut.nxsp' })
})

test('a Save that throws while reserved leaves the next Save able to run', async ({ page }) => {
    await start(page)
    await edit(page, 1)
    // nse-bind refused once: the pick's identity check throws.
    await page.evaluate(async () => {
        const module =
            (await import('/src/platform/index.ts')) as typeof import('../../src/platform')
        const own = module.platform
        let failed = false
        module.setPlatformForTests({
            ...own,
            locks: {
                ...own.locks,
                request: (name, options, callback) => {
                    if (name === 'nse-bind' && !failed) {
                        failed = true
                        return Promise.reject(new Error('Lock refused'))
                    }
                    return own.locks.request(name, options, callback)
                },
            },
        })
    })
    await queuePicks(page, ['coconut.nxsp', 'coconut.nxsp'])
    await pressSave(page)
    await submitSave(page, 'coconut')
    // The throw is shown as a failed Save, and the queue is free for the next one.
    await expect(page.getByRole('dialog')).toContainText('"coconut.nxsp" could not be written.')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
})

for (const dialogOpen of [false, true]) {
    test(`Export takeover revokes identical bytes with old dialog ${dialogOpen ? 'open' : 'closed'}`, async ({
        context,
    }) => {
        const a = await context.newPage()
        await start(a)
        await edit(a, 1)
        await queuePicks(a, ['LevelData'])
        await a.keyboard.press('Shift+P')
        await expect(a.getByRole('dialog').filter({ hasText: 'Export Level Data' })).toBeVisible()
        await a.keyboard.press('Enter')
        await expect(notice(a).filter({ hasText: 'Exported to LevelData' })).toBeVisible()
        const original = await readFile(a, 'LevelData')
        const aChain = await chainOf(a)
        await edit(a, 2)
        if (dialogOpen) {
            await a.keyboard.press('Shift+P')
            await expect(a.getByRole('dialog').locator('[data-export-target-name]')).toBeVisible()
        }
        const b = await context.newPage()
        await start(b)
        await edit(b, 1)
        await queuePicks(b, ['LevelData'])
        await b.keyboard.press('Shift+P')
        await expect(b.getByRole('dialog').filter({ hasText: 'Export Level Data' })).toBeVisible()
        await b.keyboard.press('Enter')
        await expect(notice(b).filter({ hasText: 'Exported to LevelData' })).toBeVisible()
        expect(await readFile(b, 'LevelData')).toEqual(original)
        expect((await chainById(b, aChain.chainId))?.exportTarget).toBeUndefined()
        await a.bringToFront()
        await queuePicks(a, ['OtherLevelData'])
        if (!dialogOpen) {
            await a.keyboard.press('Shift+P')
            await expect(a.getByRole('dialog').getByRole('textbox')).toBeVisible()
        }
        await a.keyboard.press('Enter')
        await expect(notice(a).filter({ hasText: 'Exported to OtherLevelData' })).toBeVisible()
        expect(await readFile(b, 'LevelData')).toEqual(original)
        expect(await readFile(a, 'OtherLevelData')).not.toEqual(original)
        expect((await chainOf(a)).exportTarget).toMatchObject({ name: 'OtherLevelData' })
    })
}

test('Export’s picker: the chain’s own file changed on disk is put back, and the conflict dialog opens', async ({
    page,
}) => {
    await start(page)
    await savedTo(page, 'coconut.nxsp')
    await changeOnDisk(page, 'coconut.nxsp')
    const changed = await readFile(page, 'coconut.nxsp')
    await queuePicks(page, ['coconut.nxsp'])
    await page.keyboard.press('Shift+P')
    await expect(page.getByRole('dialog').filter({ hasText: 'Export Level Data' })).toBeVisible()
    // The read before the picker (R2) has time to finish.
    await page.waitForTimeout(500)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toContainText('"coconut.nxsp" Changed')
    expect(await readFile(page, 'coconut.nxsp')).toEqual(changed)
})

test('Export’s picker: the chain’s own file that could not be written again says so', async ({
    page,
}) => {
    await start(page)
    await savedTo(page, 'coconut.nxsp')
    // Another Save holds the reservation.
    await page.evaluate(() => {
        ;(window as { held?: unknown }).held = window.nseFlushTest!.flusher.reserveSave()
    })
    await queuePicks(page, ['coconut.nxsp'])
    await page.keyboard.press('Shift+P')
    await expect(page.getByRole('dialog').filter({ hasText: 'Export Level Data' })).toBeVisible()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('"coconut.nxsp" could not be written.')
    await expect(dialog).not.toContainText('is not level data')
})

test('in safe mode Save writes from this tab, refusing only to take over another session’s file', async ({
    context,
}) => {
    const b = await context.newPage()
    await start(b)
    await savedTo(b, 'coconut.nxsp')

    const safe = await context.newPage()
    await safe.addInitScript(() => {
        localStorage.setItem('nse.test.storage', '{}')
        localStorage.setItem(
            'nse.test.version',
            JSON.stringify({ appVersion: '0.6.0', atTag: true }),
        )
    })
    await safe.addInitScript(installTestPlatform, { fileSystemAccess: 'opfs' as const })
    await safe.goto('/?safe')
    await expect(safe.locator('[data-safe-bar]')).toBeVisible()
    await waitForStartup(safe)
    await edit(safe, 1)
    await pressSave(safe)
    await submitSave(safe, 'melt')
    await expect(notice(safe).filter({ hasText: 'Saved to melt.nxsp' })).toBeVisible()
    const first = await projectOf(safe, 'melt.nxsp')
    // Bound in memory: the next Save writes in place.
    await edit(safe, 2)
    await pressSave(safe)
    await expect
        .poll(async () => ((await projectOf(safe, 'melt.nxsp')).revision as Row).parent)
        .toBe((first.revision as Row).id)

    // Another session's file needs a stored revocation: refused (R11).
    await safe.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs)
    })
    await queuePicks(safe, ['coconut.nxsp'])
    await submitSave(safe, undefined, 'Save As')
    await expect(safe.getByRole('dialog')).toContainText(
        'Not saved. Files cannot be replaced in safe mode.',
    )
    // The owner keeps its binding, and its next Save fills the emptied file (R9).
    await b.bringToFront()
    await edit(b, 4)
    await pressSave(b)
    await expect
        .poll(async () => (await readFile(b, 'coconut.nxsp'))?.length ?? 0, { timeout: 10_000 })
        .toBeGreaterThan(0)
    await expect(b.getByRole('dialog')).toHaveCount(0)
})

test('ordinary Save As clears Export destination and name in the file and after reload', async ({
    page,
}) => {
    await start(page)
    await edit(page, 1)
    await queuePicks(page, ['LevelData'])
    await page.keyboard.press('Shift+P')
    await expect(page.getByRole('dialog').getByRole('textbox')).toBeVisible()
    await page.getByRole('dialog').getByRole('textbox').fill('Old export')
    await page.keyboard.press('Enter')
    await expect(notice(page).filter({ hasText: 'Exported to LevelData' })).toBeVisible()
    const original = await readFile(page, 'LevelData')
    expect((await chainOf(page)).exportName).toBe('Old export')
    await page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs)
    })
    await queuePicks(page, ['copy.nxsp'])
    await submitSave(page, 'copy', 'Save As')
    await expect(notice(page).filter({ hasText: 'Saved to copy.nxsp' })).toBeVisible()
    expect((await projectOf(page, 'copy.nxsp')).exportName).toBeUndefined()
    expect((await chainOf(page)).exportTarget).toBeUndefined()
    expect((await chainOf(page)).exportName).toBeUndefined()
    await page.keyboard.press('Shift+P')
    await expect(page.getByRole('dialog').getByRole('textbox')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.reload()
    await waitForStartup(page)
    await edit(page, 2)
    await queuePicks(page, ['CopyLevelData'])
    await page.keyboard.press('Shift+P')
    await expect(page.getByRole('dialog').getByRole('textbox')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(notice(page).filter({ hasText: 'Exported to CopyLevelData' })).toBeVisible()
    expect(await readFile(page, 'LevelData')).toEqual(original)
})

test('Export refuses takeover when its revocation cannot be kept', async ({ context }) => {
    const owner = await context.newPage()
    await start(owner)
    await savedTo(owner, 'coconut.nxsp')
    const exporter = await context.newPage()
    await exporter.addInitScript(() => {
        sessionStorage.setItem('nse.test.storage', JSON.stringify({ forceQuota: true }))
        const setItem = Storage.prototype.setItem
        Storage.prototype.setItem = function (key, value) {
            if (key.includes('.revoke.')) throw new DOMException('Full', 'QuotaExceededError')
            setItem.call(this, key, value)
        }
    })
    await start(exporter)
    await edit(exporter, 5)
    await queuePicks(exporter, ['coconut.nxsp'])
    await exporter.keyboard.press('Shift+P')
    await expect(
        exporter.getByRole('dialog').filter({ hasText: 'Export Level Data' }),
    ).toBeVisible()
    await exporter.keyboard.press('Enter')
    await expect(exporter.getByRole('dialog')).toContainText('"coconut.nxsp" could not be written.')
    expect(await readFile(owner, 'coconut.nxsp')).toEqual([])
    expect((await chainOf(owner)).file).toMatchObject({ name: 'coconut.nxsp' })
    await owner.bringToFront()
    await edit(owner, 4)
    await pressSave(owner)
    await expect
        .poll(async () => (await readFile(owner, 'coconut.nxsp'))?.length ?? 0)
        .toBeGreaterThan(0)
    expect((await projectOf(owner, 'coconut.nxsp')).id).toBe((await chainOf(owner)).docId)
})

test('recognizing a completed Save As clears the prior Export suggestion after reload', async ({
    page,
}) => {
    await start(page)
    await savedTo(page, 'original.nxsp')
    await queuePicks(page, ['LevelData'])
    await page.keyboard.press('Shift+P')
    await expect(page.getByRole('dialog').getByRole('textbox')).toBeVisible()
    await page.getByRole('dialog').getByRole('textbox').fill('Old export')
    await page.keyboard.press('Enter')
    await expect(notice(page).filter({ hasText: 'Exported to LevelData' })).toBeVisible()
    await pauseAt(page, 'closed')
    await page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs)
    })
    await queuePicks(page, ['copy.nxsp'])
    await submitSave(page, 'copy', 'Save As')
    await reached(page, 'closed')
    await page.evaluate(() => localStorage.removeItem('nse.test.savePause'))
    await page.reload()
    await waitForStartup(page)
    await pressSave(page)
    await expect(
        notice(page).filter({ hasText: 'No changes since copy.nxsp was saved' }),
    ).toBeVisible()
    expect((await chainOf(page)).exportName).toBeUndefined()
    expect((await chainOf(page)).exportTarget).toBeUndefined()
    await page.keyboard.press('Shift+P')
    const name = page.getByRole('dialog').getByRole('textbox')
    await expect(name).toBeVisible()
    await expect(name).not.toHaveValue('Old export')
})

for (const choice of ['same file', 'cancelled']) {
    test(`Save As ${choice} retains its Export destination and name`, async ({ page }) => {
        await start(page)
        await savedTo(page, 'coconut.nxsp')
        const docId = (await chainOf(page)).docId
        await queuePicks(page, ['LevelData'])
        await page.keyboard.press('Shift+P')
        await expect(page.getByRole('dialog').getByRole('textbox')).toBeVisible()
        await page.getByRole('dialog').getByRole('textbox').fill('Old export')
        await page.keyboard.press('Enter')
        await expect(notice(page).filter({ hasText: 'Exported to LevelData' })).toBeVisible()
        await page.evaluate(async () => {
            const { commands } = await import('/src/editor/commands/index.ts')
            const { runCommand } = await import('/src/editor/commands/runCommand.ts')
            void runCommand(commands.saveAs)
        })
        await queuePicks(page, [choice === 'same file' ? 'coconut.nxsp' : null])
        await submitSave(page, undefined, 'Save As')
        await expect(page.getByRole('dialog')).toHaveCount(0)
        expect((await chainOf(page)).docId).toBe(docId)
        expect((await chainOf(page)).exportName).toBe('Old export')
        expect((await chainOf(page)).exportTarget).toMatchObject({ name: 'LevelData' })
        await page.keyboard.press('Shift+P')
        await expect(page.getByRole('dialog').locator('[data-export-target-name]')).toBeVisible()
    })
}
