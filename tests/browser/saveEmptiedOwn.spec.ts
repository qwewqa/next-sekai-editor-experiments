import { expect, test } from '@playwright/test'
import {
    chainOf,
    edit,
    flushed,
    notice,
    pauseAt,
    pressSave,
    queuePicks,
    reached,
    readFile,
    release,
    rows,
    saveDialog,
    sessionOf,
    start,
    submitSave,
} from './saveFlows'

test('Save As: failed reads after a completed write do not mean the own file is empty', async ({
    page,
}) => {
    await start(page)
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await queuePicks(page, ['coconut.nxsp'])
    await pauseAt(page, 'readBack')
    await page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs, 'button')
    })
    await submitSave(page, undefined, 'Save As')
    await reached(page, 'readBack')
    const written = await readFile(page, 'coconut.nxsp')
    expect(written?.length).toBeGreaterThan(0)
    await page.evaluate(() => {
        const original = FileSystemFileHandle.prototype.getFile
        let failures = 0
        FileSystemFileHandle.prototype.getFile = function () {
            if (this.name !== 'coconut.nxsp') return original.call(this)
            failures++
            return Promise.reject(new DOMException('Read failed', 'NotReadableError'))
        }
        ;(window as unknown as { restoreFileReads: () => number }).restoreFileReads = () => {
            FileSystemFileHandle.prototype.getFile = original
            return failures
        }
    })
    await release(page)
    const failure = saveDialog(page, 'Save')
    await expect(failure).toBeVisible()
    await expect(failure).not.toContainText('is now empty')
    await expect(failure).toContainText('“coconut.nxsp” changed while it was being written.')
    expect(
        await page.evaluate(() =>
            (window as unknown as { restoreFileReads: () => number }).restoreFileReads(),
        ),
    ).toBeGreaterThanOrEqual(2)
    expect(await readFile(page, 'coconut.nxsp')).toEqual(written)
})

for (const flow of ['Save As', 'Export Level Data', 'Recent Sessions'] as const) {
    test(`${flow}: a failed write gives its reason and says the file is now empty`, async ({
        page,
    }) => {
        await start(page)
        await edit(page, 1)
        await flushed(page)
        const earlier = await sessionOf(page)
        await page.evaluate(async () => {
            const { resetState } = await import('/src/history/index.ts')
            resetState(false)
        })
        await edit(page, 2)
        await pressSave(page)
        await submitSave(page, 'coconut')
        await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
        const before = await chainOf(page)
        const entries = (await rows(page, ['entries'])).entries!
        await page.evaluate(async () => {
            const module =
                (await import('/src/platform/index.ts')) as typeof import('../../src/platform')
            const original = module.platform
            const seen = window as unknown as { ownFileEvents: string[] }
            seen.ownFileEvents = []
            module.setPlatformForTests({
                ...original,
                saveFile: (request) => {
                    if (request.kind === 'nxsp' || request.kind === 'nsld') {
                        seen.ownFileEvents.push('no-space')
                        // Named as the platform names a failed write.
                        const name =
                            request.target?.kind === 'handle'
                                ? request.target.handle.name
                                : undefined
                        throw new module.FileError(
                            'no-space',
                            'Disk full',
                            undefined,
                            undefined,
                            name,
                        )
                    }
                    return original.saveFile(request)
                },
                read: async (target) => {
                    const found = await original.read(target)
                    if (seen.ownFileEvents.includes('no-space'))
                        seen.ownFileEvents.push(`read:${found.size}`)
                    return found
                },
                inspect: async (target, kind) => {
                    const found = await original.inspect(target, kind)
                    if (seen.ownFileEvents.includes('no-space') && found !== 'missing')
                        seen.ownFileEvents.push(`inspected:${found.size}`)
                    return found
                },
            })
        })
        await queuePicks(page, ['coconut.nxsp'])
        if (flow === 'Recent Sessions') {
            await page.evaluate((sessionId) => {
                void import('/src/editor/save/flow.ts').then((flow) => flow.saveToFile(sessionId))
            }, earlier.sessionId)
            await submitSave(page)
        } else {
            await page.evaluate(async (flow) => {
                const { commands } = await import('/src/editor/commands/index.ts')
                const { runCommand } = await import('/src/editor/commands/runCommand.ts')
                void runCommand(
                    flow === 'Save As' ? commands.saveAs : commands.exportLevel,
                    'button',
                )
            }, flow)
            if (flow === 'Save As') await submitSave(page, undefined, 'Save As')
            else
                await saveDialog(page, 'Export Level Data')
                    .getByRole('button', { name: 'Export', exact: true })
                    .click()
        }

        const offer = saveDialog(page, flow === 'Export Level Data' ? flow : 'Save')
        await expect(offer).toContainText('There is not enough space to write coconut.nxsp.')
        await expect(offer).toContainText('The file is now empty.')
        await expect(
            offer.getByRole('button', {
                name: flow === 'Export Level Data' ? 'Choose Another…' : 'Save As…',
                exact: true,
            }),
        ).toBeVisible()
        await expect(offer.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0)
        expect(await readFile(page, 'coconut.nxsp')).toEqual([])
        expect(
            await page.evaluate(
                () => (window as unknown as { ownFileEvents: string[] }).ownFileEvents,
            ),
        ).toEqual(['no-space', 'read:0'])
        const locks = await page.evaluate(async () => (await navigator.locks.query()).held)
        expect(locks?.some((lock) => lock.name === 'nse-bind')).toBe(false)

        await page.keyboard.press('Escape')
        await expect(saveDialog(page, flow === 'Export Level Data' ? flow : 'Save')).toHaveCount(0)
        expect((await chainOf(page)).file).toEqual(flow === 'Save As' ? before.file : undefined)
        expect((await rows(page, ['entries'])).entries).toEqual(expect.arrayContaining(entries))
        expect(await readFile(page, 'coconut.nxsp')).toEqual([])
    })
}
