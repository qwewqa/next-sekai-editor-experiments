import { expect, test, type FileChooser } from '@playwright/test'
import { en } from './messages'
import { edit, notice, start, writeFile } from './saveFlows'

// After an edit, Open waits up to FIRST_WRITE_WAIT_MS for the visit's first write (confirmSwitch)
// before it calls the file picker, and the press must still count as a user action then. A picker
// called without it refuses, and Open shows nothing. Not run in WebKit: Playwright's WebKit
// reports no chooser for showPicker(), and the suite routes it back to click(), which Safari
// does not use.

type Pick = { active: boolean; waited: number }

// How long into the wait the held first write lands, well inside it so a slow flush still fits.
const LANDS_AT = 500

const usc = Buffer.from(
    JSON.stringify({
        version: 2,
        usc: {
            offset: 0,
            objects: [
                { type: 'bpm', beat: 0, bpm: 120 },
                { type: 'timeScaleGroup', changes: [{ beat: 0, timeScale: 1 }] },
                {
                    type: 'single',
                    beat: 1,
                    timeScaleGroup: 0,
                    lane: 0,
                    size: 1,
                    critical: false,
                    trace: false,
                },
            ],
        },
    }),
)

/**
 * Reports each picker call with whether the press still counted as a user action and how long after
 * the press it came. With `hold`, the page's own clock releases the held flushes that long after the press.
 */
const watchOpen = ({ native, hold }: { native: boolean; hold: number | undefined }) => {
    let pressedAt = 0
    document.addEventListener(
        'keydown',
        (event) => {
            if (event.key !== 'o') return
            pressedAt = performance.now()
            if (hold !== undefined)
                setTimeout(() => {
                    window.nseFlushTest!.stall = false
                }, hold)
        },
        true,
    )
    const note = (): Pick => {
        const pick = {
            active: navigator.userActivation.isActive,
            waited: performance.now() - pressedAt,
        }
        void (window as unknown as { reportPick: (pick: Pick) => void }).reportPick(pick)
        return pick
    }
    if (native)
        Object.defineProperty(window, 'showOpenFilePicker', {
            configurable: true,
            // As Chromium's, which refuses without a user action; the file is one in OPFS.
            value: async () => {
                if (!note().active) throw new DOMException('Needs a user action', 'SecurityError')
                const root = await navigator.storage.getDirectory()
                return [await root.getFileHandle('chart.usc')]
            },
        })
    else {
        const showPicker = HTMLInputElement.prototype.showPicker
        HTMLInputElement.prototype.showPicker = function () {
            note()
            return showPicker.call(this)
        }
    }
}

for (const { picker, native } of [
    { picker: 'showPicker', native: false },
    { picker: 'showOpenFilePicker', native: true },
])
    for (const { held, hold } of [
        { held: 'nothing held', hold: undefined },
        { held: `its first write landing ${LANDS_AT} ms into the wait`, hold: LANDS_AT },
    ])
        test(`an edit and at once Open, ${held}: ${picker} is called while the press is still a user action, and the file opens`, async ({
            page,
            browserName,
        }) => {
            test.skip(native && browserName !== 'chromium', "showOpenFilePicker is Chromium's")
            const picks: Pick[] = []
            await page.exposeFunction('reportPick', (pick: Pick) => {
                picks.push(pick)
            })
            await page.addInitScript(watchOpen, { native, hold })
            await start(page, { fileSystemAccess: native })
            await expect
                .poll(() => page.evaluate(() => window.nseFlushTest !== undefined))
                .toBe(true)
            if (native) await writeFile(page, 'chart.usc', usc)
            if (hold !== undefined)
                await page.evaluate(() => {
                    window.nseFlushTest!.stall = true
                })
            await edit(page, 4)
            const chooser = new Promise<FileChooser>((resolve) => page.once('filechooser', resolve))
            await page.keyboard.press('o')
            // Nothing calls into the page until the picker is called: in Chromium and Firefox each
            // Playwright call renews the page's user action, which would hide a lost one.
            await expect
                .poll(() => picks.length, { message: 'Open called the picker', timeout: 15_000 })
                .toBe(1)
            expect(picks[0]!.active, 'the press still counted as a user action').toBe(true)
            if (hold !== undefined)
                expect(
                    picks[0]!.waited,
                    'the picker came after the first write',
                ).toBeGreaterThanOrEqual(hold)
            if (!native)
                await (
                    await chooser
                ).setFiles({ name: 'chart.usc', mimeType: 'application/octet-stream', buffer: usc })
            await expect(
                notice(page).filter({ hasText: en.commands.open.importedUsc }),
            ).toBeVisible({ timeout: 15_000 })
        })
