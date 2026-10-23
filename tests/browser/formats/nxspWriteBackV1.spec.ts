import { expect, test, type Page } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readNxsp } from '../../../src/local/nxsp'
import { ZipReader } from '../../../src/zip'
import { Editor } from '../../samples/driver'
import { queuePicks, readFile, writeFile } from '../saveFlows'
import { skipWhereTheEditorCannotStart } from '../webkitSupport'
import { rowsOf, seededContext, visit } from './seed'

// Each v1 `.nxsp` fixture with history (tests/native/fixtures/nxsp-v1/, Part 1 §1.6.11.9), opened
// under the OPFS override, edited once and saved back in place (§1.6.11.6). The Save is an append:
// the result opens fully, its chronology begins with the fixture's, its `chunks.bin` begins with the
// fixture's bytes, its segments are the fixture's, and its `completeFrom` is the fixture's. This is
// the path that would lose a user's history if a later appender misread a v1 source.

// A WebKit build without OffscreenCanvas cannot start the editor; the override's pickers are Chromium's.
skipWhereTheEditorCannotStart()

test.skip(({ browserName }) => browserName !== 'chromium', 'The write-back uses Chromium’s pickers')

const root = resolve(import.meta.dirname, '../../native/fixtures/nxsp-v1')
const withHistory = readdirSync(root).filter(
    (name) => name.endsWith('.nxsp') && name !== 'no-history.nxsp',
)

const START = Date.UTC(2026, 10, 12, 10)

/** A file's parts: `project.json`, its history and the bytes of `chunks.bin` and each segment. */
const partsOf = async (bytes: Uint8Array) => {
    const blob = new Blob([new Uint8Array(bytes)])
    const read = await readNxsp(blob)
    if (read.kind !== 'nxsp' || !read.history) throw new Error('A file with history was expected')
    const zip = await ZipReader.open(blob)
    const entry = async (name: string) => {
        const found = zip.get(name)
        if (!found) throw new Error(`No ${name}`)
        return new Uint8Array(await zip.read(found, { maxSize: 1 << 30 }))
    }
    const project = read.projectJson as {
        revision: Record<string, unknown>
        history: { segments?: string[] }
    }
    const segments = await Promise.all((project.history.segments ?? []).map((name) => entry(name)))
    return {
        read,
        history: read.history,
        project,
        chunks: await entry('history/chunks.bin'),
        segments,
    }
}

const savedRevision = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        const { ZipReader } = await import('/src/zip/reader.ts')
        try {
            const file = await (await root.getFileHandle(name)).getFile()
            const zip = await ZipReader.open(file)
            const text = await zip.read(zip.get('project.json')!, { maxSize: 4_000_000 })
            return (JSON.parse(new TextDecoder().decode(text)) as { revision: { n: number } })
                .revision.n
        } catch {
            return 0
        }
    }, name)

for (const name of withHistory)
    test(`${name} saved back in place keeps its history`, async ({ browser }) => {
        test.setTimeout(120_000)
        // Catches a later appender that misreads a v1 source and drops or reorders its rows, rewrites
        // its chunks or segments, or changes its `completeFrom` (the user's history lost on the next Save).
        const bytes = new Uint8Array(readFileSync(join(root, name)))
        const { context, clock } = await seededContext(browser, undefined, {
            start: START,
            files: 'opfs',
        })
        const page = await visit(context, clock)
        await writeFile(page, name, bytes)
        await queuePicks(page, [name])
        await page.keyboard.press('o')
        // The open says "Opened", or that the BGM is not loaded: the label names the file either way.
        await expect(page.locator('[data-status-label]')).toContainText(name)
        await expect
            .poll(
                async () =>
                    ((await rowsOf(page, ['sessions'])).sessions ?? []).filter(
                        (row) => row.value.importPending === true,
                    ).length,
            )
            .toBe(0)
        const before = await partsOf(bytes)
        const editor = new Editor(page)
        await editor.ready()
        await editor.command('a')
        await editor.focus(5000)
        await expect.poll(() => editor.act(() => editor.click(0, 5000))).toBeTruthy()
        await editor.settled()
        const revision = before.project.revision.n as number
        await page.locator('canvas.editor-chart').focus()
        await page.keyboard.press('p')
        await expect.poll(() => savedRevision(page, name), { timeout: 30_000 }).toBe(revision + 1)

        const after = await partsOf(new Uint8Array((await readFile(page, name))!))
        expect(after.read.open).toBe('full')
        expect(after.read.report).toEqual([])
        // The chronology begins with the fixture's, and ends with the Save and the edit's rows.
        const was = before.history.entries
        const now = after.history.entries
        expect(now.length).toBeGreaterThan(was.length)
        expect(now.slice(0, was.length)).toEqual(was)
        expect(now.at(-1)?.kind).toBe('save')
        // chunks.bin begins with the fixture's bytes, whole.
        expect(after.chunks.length).toBeGreaterThan(before.chunks.length)
        expect(Buffer.compare(after.chunks.subarray(0, before.chunks.length), before.chunks)).toBe(
            0,
        )
        // The segments are the fixture's, copied whole.
        expect(after.segments.length).toBeGreaterThanOrEqual(before.segments.length)
        for (const [i, segment] of before.segments.entries())
            expect(Buffer.compare(after.segments[i]!, segment)).toBe(0)
        // The revision descends from the fixture's, and completeFrom is carried.
        expect(after.project.revision).toMatchObject({
            parent: before.project.revision.id,
            completeFrom: before.project.revision.completeFrom,
        })
        // The undo stack's head is the edit: its state is not the fixture's head.
        expect(after.history.head).not.toBe(before.history.head)
        await context.close()
    })
