import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Shared state and cleanup the sibling sweep found (2026-10-20): a jump under Edits Here replaces
// nothing, and a switch's watcher goes with its card.

const boot = async (page: Page) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
}

test('a jump under Edits Here does not replace the loaded run', async ({ page }) => {
    await boot(page)
    const moved = await page.evaluate(async () => {
        const source = await window.editorTest.appImport<
            typeof import('../../src/editor/history/source')
        >('/src/editor/history/source.ts')
        const before = source.sourceGeneration.value
        const found = await source.jumpTo({ sessionId: 'none', seq: 1 }, 'here')
        return { found, moved: source.sourceGeneration.value !== before }
    })
    expect(moved).toEqual({ moved: false })
})

test("a switch's watcher goes with its Reopen card, however the card goes", async ({ page }) => {
    await boot(page)
    // The watchers on the session left: one for each switch that still offers Reopen.
    const subscribers = () =>
        page.evaluate(async () => {
            const { previousSession } = await window.editorTest.appImport<
                typeof import('../../src/local/startup/events')
            >('/src/local/startup/events.ts')
            let count = 0
            const dep = (previousSession as unknown as { dep: { subs?: { prevSub?: unknown } } })
                .dep
            let link = dep.subs as { prevSub?: unknown } | undefined
            while (link) {
                count++
                link = link.prevSub as { prevSub?: unknown } | undefined
            }
            return count
        })
    const before = await subscribers()
    for (let n = 0; n < 3; n++)
        await page.evaluate(async () => {
            const events = await window.editorTest.appImport<
                typeof import('../../src/local/startup/events')
            >('/src/local/startup/events.ts')
            const { notifyLeft } =
                await window.editorTest.appImport<typeof import('../../src/editor/switch')>(
                    '/src/editor/switch.ts',
                )
            const { dismissNoticeCard } = await window.editorTest.appImport<
                typeof import('../../src/editor/notification')
            >('/src/editor/notification.ts')
            events.previousSession.value = {
                sessionId: crypto.randomUUID(),
                name: { name: { kind: 'name', text: 'Old' }, at: 0 },
            }
            notifyLeft(() => 'New level')
            await window.editorTest.nextTick()
            // The card goes without the session left changing.
            dismissNoticeCard()
            await window.editorTest.nextTick()
        })
    expect(await subscribers()).toBe(before)
})
