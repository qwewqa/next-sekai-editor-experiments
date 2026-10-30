import { expect, test, type Browser, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readNxsp } from '../../../src/local/nxsp'
import { ZipReader } from '../../../src/zip'
import {
    chainOf,
    edit,
    flushed,
    notice,
    pauseAt,
    pressSave,
    projectOf,
    queuePicks,
    reached,
    readFile,
    release,
    rows,
    saveStored,
    start,
    writeFile,
} from '../saveFlows'
import { skipWhereTheEditorCannotStart } from '../webkitSupport'

skipWhereTheEditorCannotStart()
test.skip(({ browserName }) => browserName !== 'chromium', "The write-back uses Chromium's pickers")

const legacy = join(import.meta.dirname, '../../local/nxsp/legacy-test20f')
const bytesOf = (name: string) => new Uint8Array(readFileSync(join(legacy, name)))

const inspected = async (bytes: Uint8Array) => {
    const blob = new Blob([new Uint8Array(bytes)])
    const read = await readNxsp(blob)
    if (read.kind !== 'nxsp' || read.open !== 'full' || !read.project)
        throw new Error('A complete project was expected')
    expect(read.report).toEqual([])
    const zip = await ZipReader.open(blob)
    const data = async (name: string) => {
        const entry = zip.get(name)
        if (!entry) throw new Error(`No ${name}`)
        return zip.read(entry, { maxSize: 1 << 30 })
    }
    const segments = await Promise.all(
        zip.entries
            .filter((entry) => entry.name.startsWith('history/segments/'))
            .map(async (entry) => ({
                name: entry.name,
                method: entry.method,
                stored: new Uint8Array(await (await zip.stored(entry)).arrayBuffer()),
            })),
    )
    return { read, project: read.project, zip, data, segments }
}

type Inspected = Awaited<ReturnType<typeof inspected>>

const expectAppend = async (before: Inspected, after: Inspected) => {
    if (!before.read.history || !after.read.history) throw new Error('History was expected')
    expect(after.project.id).toBe(before.project.id)
    expect(after.project.lineageId).toBe(before.project.lineageId)
    expect(after.project.revision?.parent).toBe(before.project.revision?.id)
    expect(after.project.revision?.ancestors).toContain(before.project.revision?.id)
    expect(after.project.revision?.completeFrom).toBe(before.project.revision?.completeFrom)
    expect(after.read.history.entries.slice(0, before.read.history.entries.length)).toEqual(
        before.read.history.entries,
    )
    expect(after.read.history.entries.at(-1)?.kind).toBe('save')
    for (const segment of before.segments)
        expect(after.segments.find((entry) => entry.name === segment.name)).toEqual(segment)
    const prefix = await before.data('history/chunks.bin')
    const chunks = await after.data('history/chunks.bin')
    expect(chunks.subarray(0, prefix.length)).toEqual(prefix)
}

const expectPackage = async (file: Inspected) => {
    expect(file.project.level).toBe('level.json.gz')
    expect(
        file.zip.entries.filter((entry) => /^level\.json(?:\.gz)?$/.test(entry.name)),
    ).toHaveLength(1)
    expect(file.zip.get('level.json.gz')?.method).toBe(0)
    expect([...(await file.data('level.json.gz')).subarray(0, 3)]).toEqual([0x1f, 0x8b, 8])
    const list = JSON.parse(new TextDecoder().decode(await file.data('sonolus/levels/list'))) as {
        items: {
            data: { hash: string; url: string }
            bgm: { hash?: string; url?: string }
            cover: { hash?: string; url?: string }
        }[]
    }
    expect(list.items).toHaveLength(1)
    expect(list.items[0]?.data).toEqual({
        hash: createHash('sha1')
            .update(await file.data('level.json.gz'))
            .digest('hex'),
        url: '/level.json.gz',
    })
    for (const kind of ['bgm', 'cover'] as const) {
        const media = file.read.media[kind]
        const path = media?.form.file ?? (kind === 'bgm' ? 'sonolus/bgm.mp3' : 'sonolus/cover.png')
        expect(list.items[0]?.[kind]).toEqual({
            hash: createHash('sha1')
                .update(await file.data(path))
                .digest('hex'),
            url: `/${path}`,
        })
    }
}

const openFile = async (page: Page, name: string, bytes: Uint8Array) => {
    await writeFile(page, name, bytes)
    await queuePicks(page, [name])
    await page.locator('canvas.editor-chart').focus()
    await page.keyboard.press('o')
    await expect(page.locator('[data-status-label]')).toContainText(name)
    await expect
        .poll(
            async () =>
                (await rows(page, ['sessions'])).sessions!.filter(
                    (row) => row.value.importPending === true,
                ).length,
        )
        .toBe(0)
    await expect
        .poll(async () => (await chainOf(page)).file)
        .toMatchObject({ name, event: 'opened' })
    const entries = (await rows(page, ['entries'])).entries!
    expect(
        entries.filter(
            (entry) =>
                (entry.value.step as { operation?: { id?: string } } | undefined)?.operation?.id ===
                'nse.externalChange',
        ),
    ).toEqual([])
}

const offlinePage = async (browser: Browser) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await start(page)
    const origin = new URL(page.url()).origin
    const external: string[] = []
    await context.route('**/*', async (route) => {
        const url = route.request().url()
        if (new URL(url).origin === origin) await route.continue()
        else {
            external.push(url)
            await route.abort()
        }
    })
    return { context, page, external }
}

const liveRoot = (page: Page) =>
    page.evaluate(async () => {
        const { liveState } = await import('/src/history/stack.ts')
        const { rootOf } = await import('/src/editor/save/build.ts')
        return rootOf(liveState.value)
    })

const saved = async (page: Page, name: string, before: Inspected) => {
    await pressSave(page)
    await expect
        .poll(async () => (await projectOf(page, name)).revision, { timeout: 30_000 })
        .toMatchObject({ n: before.project.revision!.n + 1 })
    await saveStored(page)
    return inspected(new Uint8Array((await readFile(page, name))!))
}

test('a legacy file keeps its source-only media and segmented history through two offline Saves', async ({
    browser,
}) => {
    test.setTimeout(120_000)
    const original = await inspected(bytesOf('full.nxsp'))
    expect(original.segments.length).toBeGreaterThan(0)
    if (!original.read.history) throw new Error('Legacy history was expected')
    const first = await offlinePage(browser)
    try {
        await openFile(first.page, 'legacy.nxsp', bytesOf('full.nxsp'))
        expect(await liveRoot(first.page)).toBe(original.read.history.head)
        const stack = original.read.history.undoStack
        expect(stack.index).toBeGreaterThan(0)
        await first.page.keyboard.press('z')
        await expect.poll(() => liveRoot(first.page)).toBe(stack.slots[stack.index - 1]!.snapshot)
        await first.page.evaluate(async () => {
            const { redoState } = await import('/src/history/index.ts')
            redoState()
        })
        await expect.poll(() => liveRoot(first.page)).toBe(original.read.history!.head)
        await edit(first.page, 2000)
        await flushed(first.page)
        // No picked cover or preview is held; their only remaining bytes are in the source file.
        const hashes = ['cover', 'preview'].map((kind) =>
            original.read.media[kind as 'cover' | 'preview']!.form.sha256!.slice(0, 32),
        )
        await first.page.evaluate(async (hashes) => {
            const { DB_NAME, hashKey } = await import('/src/local/db.ts')
            const { fromHex16 } = await import('/src/local/hash.ts')
            const { heldItemsOf } = await import('/src/local/heldMedia.ts')
            const { liveState } = await import('/src/history/stack.ts')
            if (heldItemsOf(liveState.value).some((item) => hashes.includes(item.hash)))
                throw new Error('The source-only media must not be held by the page')
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const open = indexedDB.open(DB_NAME)
                open.onsuccess = () => resolve(open.result)
                open.onerror = () => reject(open.error)
            })
            try {
                await new Promise<void>((resolve, reject) => {
                    const tx = db.transaction('media', 'readwrite')
                    for (const hash of hashes)
                        tx.objectStore('media').delete(hashKey(fromHex16(hash)))
                    tx.oncomplete = () => resolve()
                    tx.onerror = () => reject(tx.error)
                })
            } finally {
                db.close()
            }
        }, hashes)
        expect(
            await first.page.evaluate(
                (hashes) => window.nseStorageTest!.worker.call('mediaHeld', hashes),
                hashes,
            ),
        ).toEqual([])
        const modern = await saved(first.page, 'legacy.nxsp', original)
        await expectPackage(modern)
        await expectAppend(original, modern)
        for (const kind of ['bgm', 'cover', 'preview'] as const) {
            expect(modern.read.media[kind]?.form.file).toBe(original.read.media[kind]?.form.file)
            expect(await modern.read.media[kind]?.bytes.arrayBuffer()).toEqual(
                await original.read.media[kind]?.bytes.arrayBuffer(),
            )
        }
        expect(first.external.filter((url) => url.includes('coconut'))).toEqual([])
        const modernBytes = new Uint8Array((await readFile(first.page, 'legacy.nxsp'))!)
        await first.context.close()

        const second = await offlinePage(browser)
        try {
            await openFile(second.page, 'legacy.nxsp', modernBytes)
            expect(await liveRoot(second.page)).toBe(modern.read.history!.head)
            await second.page.keyboard.press('z')
            await expect.poll(() => liveRoot(second.page)).toBe(original.read.history!.head)
            await second.page.evaluate(async () => {
                const { redoState } = await import('/src/history/index.ts')
                redoState()
            })
            await expect.poll(() => liveRoot(second.page)).toBe(modern.read.history!.head)
            await edit(second.page, 2001)
            const final = await saved(second.page, 'legacy.nxsp', modern)
            await expectPackage(final)
            await expectAppend(modern, final)
            expect(
                final.read.history!.entries.slice(0, original.read.history!.entries.length),
            ).toEqual(original.read.history!.entries)
            for (const segment of original.segments)
                expect(final.segments.find((entry) => entry.name === segment.name)).toEqual(segment)
            expect(final.project.revision?.parent).toBe(modern.project.revision?.id)
            expect(final.project.revision?.ancestors).toContain(original.project.revision?.id)
            expect(final.project.revision?.completeFrom).toBe(
                original.project.revision?.completeFrom,
            )
            expect(second.external.filter((url) => url.includes('coconut'))).toEqual([])
        } finally {
            await second.context.close()
        }
    } finally {
        await first.context.close()
    }
})

for (const name of ['no-history.nxsp', 'media-not-held.nxsp', 'bgm-unticked.nxsp'])
    test(`a legacy ${name} remains saveable without fetching its missing media`, async ({
        browser,
    }) => {
        const { context, page, external } = await offlinePage(browser)
        try {
            const before = await inspected(bytesOf(name))
            await openFile(page, name, bytesOf(name))
            await edit(page, 2000)
            const after = await saved(page, name, before)
            await expectPackage(after)
            expect(after.project.id).toBe(before.project.id)
            expect(after.project.lineageId).toBe(before.project.lineageId)
            expect(after.project.metadata).toEqual(before.project.metadata)
            if (before.read.history) await expectAppend(before, after)
            else expect(after.read.history).toBeDefined()
            expect(after.read.media.bgm).toBeUndefined()
            expect(external.filter((url) => url.includes('coconut'))).toEqual([])
        } finally {
            await context.close()
        }
    })

test('a legacy source changed before close is kept and leaves its binding and Save rows unchanged', async ({
    page,
}) => {
    await start(page)
    const original = bytesOf('full.nxsp')
    await openFile(page, 'legacy.nxsp', original)
    await edit(page, 2000)
    await flushed(page)
    const before = await chainOf(page)
    const saveRows = (await rows(page, ['entries'])).entries!.filter(
        (row) => row.value.kind === 'save',
    )
    await pauseAt(page, 'beforeClose')
    await pressSave(page)
    await reached(page, 'beforeClose')
    const changed = original.slice()
    const signature = changed.findIndex(
        (byte, index) =>
            byte === 0x50 &&
            changed[index + 1] === 0x4b &&
            changed[index + 2] === 1 &&
            changed[index + 3] === 2,
    )
    expect(signature).toBeGreaterThan(0)
    changed[signature + 4] = changed[signature + 4]! ^ 1
    await writeFile(page, 'legacy.nxsp', changed)
    await release(page)
    await expect(page.getByRole('dialog')).toContainText('Changed')
    expect(await readFile(page, 'legacy.nxsp')).toEqual([...changed])
    expect((await chainOf(page)).file).toEqual(before.file)
    expect((await chainOf(page)).revision).toEqual(before.revision)
    expect(
        (await rows(page, ['entries'])).entries!.filter((row) => row.value.kind === 'save'),
    ).toEqual(saveRows)
    await expect(notice(page).filter({ hasText: 'Saved to legacy.nxsp' })).toHaveCount(0)
})
