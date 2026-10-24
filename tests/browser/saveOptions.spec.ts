import { expect, test, type Page } from '@playwright/test'
import { executePlan, planNxsp } from '../../src/local/nxsp'
import { fresh } from '../local/nxsp/chain'
import { crafted, jsonOf, setJson } from '../local/nxsp/craft'
import {
    chainOf,
    edit,
    notice,
    pressSave,
    projectOf,
    queuePicks,
    rows,
    saveDialog,
    sessionOf,
    start,
    submitSave,
    undo,
    writeFile,
} from './saveFlows'

// What a Save writes is chosen per Save (Part 1 §1.4.7; owner, 2026-10-23): every Save starts
// from History and BGM included, a Save dialog's ticks apply to that one write, and nothing is
// remembered on the binding. A file that already holds history keeps it (H-5).

type Row = Record<string, unknown>

const saveAs = (page: Page) =>
    page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs)
    })

/** A dialog ignores presses in its first moments (§1.4.1). */
const settle = (page: Page) => page.waitForTimeout(400)

/** A BGM the session holds, pushed as an edit. */
const setBgm = (page: Page, name: string, size: number) =>
    page.evaluate(
        async ({ name, size }) => {
            const { pushState, state } = await import('/src/history/index.ts')
            const { captureMedia } = await import('/src/local/media.ts')
            const { bgmOperation } = await import('/src/editor/headerLabels.ts')
            const bytes = new Uint8Array(size)
            crypto.getRandomValues(bytes.subarray(0, Math.min(size, 65_536)))
            const captured = await captureMedia(bytes.buffer, { name, type: 'audio/mpeg' })
            const next = {
                ...state.value.bgm,
                filename: name,
                meta: captured.meta,
                source: captured.source,
            }
            pushState(bgmOperation(state.value.bgm, next), { ...state.value, bgm: next })
        },
        { name, size },
    )

const row = (page: Page, name: 'history' | 'bgm') =>
    saveDialog(page).locator(`[data-save-row="${name}"]`).getByRole('checkbox')

/** The first Save, to coconut.nxsp, with History or BGM unticked. */
const firstSave = async (page: Page, untick: ('history' | 'bgm')[]) => {
    await pressSave(page)
    for (const name of untick) await row(page, name).uncheck()
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await expect.poll(async () => (await chainOf(page)).file).toMatchObject({ event: 'saved' })
}

/** The open session's chain's binding, or undefined while it has no stored chain. */
const fileOf = async (page: Page) => {
    try {
        return (await chainOf(page)).file as Row | undefined
    } catch {
        return undefined
    }
}

/** Opens a file through the picker in a new session, as Open File… does. */
const openInNewSession = async (page: Page, name: string) => {
    await page.evaluate(async () => {
        const { resetState } = await import('/src/history/index.ts')
        resetState(false)
    })
    const { sessionId } = await sessionOf(page)
    await queuePicks(page, [name])
    await page.keyboard.press('o')
    await expect.poll(async () => (await sessionOf(page)).sessionId).not.toBe(sessionId)
    await expect.poll(() => fileOf(page)).toMatchObject({ name, event: 'opened' })
}

/** coconut.nxsp's revision id now. */
const revisionOf = async (page: Page) =>
    ((await projectOf(page, 'coconut.nxsp')).revision as Row).id

/** coconut.nxsp once a write after `before` replaced it. */
const writtenAfter = async (page: Page, before: unknown) => {
    await expect.poll(() => revisionOf(page)).not.toBe(before)
    return projectOf(page, 'coconut.nxsp')
}

const imported = (page: Page) =>
    expect
        .poll(async () => {
            const { sessions } = await rows(page, ['sessions'])
            return sessions!.filter((each) => each.value.importPending === true).length
        })
        .toBe(0)

const beats = (page: Page) =>
    page.evaluate(async () => {
        const { state } = await import('/src/history/index.ts')
        return state.value.bpms.map((bpm) => bpm.x)
    })

/** A plain Save, a write-back to coconut.nxsp: the file it wrote. */
const writeBack = async (page: Page) => {
    const before = await revisionOf(page)
    await pressSave(page)
    return writtenAfter(page, before)
}

/** Save As… whose picker returns coconut.nxsp, the chain's own file, with rows unticked. */
const saveAsOwn = async (page: Page, untick: ('history' | 'bgm')[] = []) => {
    const before = await revisionOf(page)
    await queuePicks(page, ['coconut.nxsp'])
    await saveAs(page)
    const dialog = saveDialog(page, 'Save As')
    await expect(dialog).toBeVisible()
    // Every row opens ticked: the defaults.
    for (const name of ['history', 'bgm'] as const) {
        const box = dialog.locator(`[data-save-row="${name}"]`).getByRole('checkbox')
        if ((await box.count()) === 0) continue
        await expect(box).toBeChecked()
        if (untick.includes(name)) await box.uncheck()
    }
    await settle(page)
    await submitSave(page, undefined, 'Save As')
    return writtenAfter(page, before)
}

test('a file opened without history gains it on a plain Save, and Undo works after reopening it', async ({
    page,
}) => {
    await start(page)
    await edit(page, 1)
    await firstSave(page, ['history'])
    const plain = await projectOf(page, 'coconut.nxsp')
    expect(plain.history).toBeUndefined()

    await openInNewSession(page, 'coconut.nxsp')
    await edit(page, 2)
    const written = await writeBack(page)
    expect(written.history).toBeDefined()
    expect(written.id).toBe(plain.id)
    const revision = written.revision as Row
    expect(revision.parent).toBe((plain.revision as Row).id)
    // Whole from the file it replaced, which held no rows.
    expect(revision.completeFrom).toBe((plain.revision as Row).id)

    await openInNewSession(page, 'coconut.nxsp')
    await imported(page)
    expect(await beats(page)).toContain(2)
    await undo(page)
    await expect.poll(() => beats(page)).not.toContain(2)
    expect(await beats(page)).toContain(1)
})

test('a History untick on a first Save does not carry to the next plain Save', async ({ page }) => {
    await start(page)
    await edit(page, 1)
    await firstSave(page, ['history'])
    expect((await projectOf(page, 'coconut.nxsp')).history).toBeUndefined()
    await edit(page, 2)
    expect((await writeBack(page)).history).toBeDefined()
})

test('Save As… with History ticked onto the chain’s own file without history includes it', async ({
    page,
}) => {
    await start(page)
    await edit(page, 1)
    await firstSave(page, ['history'])
    const plain = await projectOf(page, 'coconut.nxsp')
    await edit(page, 2)
    const written = await saveAsOwn(page)
    expect(written.history).toBeDefined()
    // The chain's own file keeps its identity (R4).
    expect(written.id).toBe(plain.id)
})

test('Save As… with BGM ticked onto the chain’s own file that left its BGM out includes it', async ({
    page,
}) => {
    await start(page)
    await edit(page, 1)
    await setBgm(page, 'song.mp3', 100_000)
    await firstSave(page, ['bgm'])
    expect((await projectOf(page, 'coconut.nxsp')).bgm).toBeUndefined()
    await edit(page, 2)
    expect((await saveAsOwn(page)).bgm).toMatchObject({ file: expect.any(String) })
})

test('a file opened with its BGM left out gets it on a plain Save once the audio is held', async ({
    page,
}) => {
    await start(page)
    await edit(page, 1)
    await setBgm(page, 'song.mp3', 100_000)
    await firstSave(page, ['bgm'])
    expect((await projectOf(page, 'coconut.nxsp')).bgm).toBeUndefined()
    // Storage holds the audio from the session that chose it.
    await openInNewSession(page, 'coconut.nxsp')
    await edit(page, 2)
    expect((await writeBack(page)).bgm).toMatchObject({ file: expect.any(String) })
})

test('a file opened with its BGM left out and not held gets the BGM as metadata', async ({
    page,
}) => {
    await start(page)
    const file = await crafted(
        (items) => {
            const project = jsonOf(items, 'project.json')
            delete project.bgm
            setJson(items, 'project.json', project)
            return items.filter((item) => !item.name.startsWith('bgm/'))
        },
        await executePlan(planNxsp(fresh().input).plan, new Map()),
    )
    await writeFile(page, 'coconut.nxsp', new Uint8Array(await file.arrayBuffer()))
    await openInNewSession(page, 'coconut.nxsp')
    await imported(page)
    await edit(page, 2)
    const bgm = (await writeBack(page)).bgm as Row
    // Not loaded, so not written as audio: the plain line, as the user knows it is not loaded.
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' }).first()).toHaveText(
        'Saved to coconut.nxsp',
    )
    expect(bgm.hash).toEqual(expect.any(String))
    expect(bgm.file).toBeUndefined()
})

test('a file with history keeps it when Save As… onto it leaves History unticked', async ({
    page,
}) => {
    await start(page)
    await edit(page, 1)
    await firstSave(page, [])
    const before = (await projectOf(page, 'coconut.nxsp')).history as Row
    expect(before).toBeDefined()
    await edit(page, 2)
    const after = (await saveAsOwn(page, ['history'])).history as Row
    expect(after).toBeDefined()
    expect(after.entries as number).toBeGreaterThan(before.entries as number)
})
