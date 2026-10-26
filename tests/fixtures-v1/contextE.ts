import { expect, type Browser } from '@playwright/test'
import { prefix } from '../samples/driver'
import type { Products } from './products'
import { selectTool, tapAt } from './ui'
import { DAY, journals, Profile, SECOND, START } from './world'

// Context E: a browser whose storage is unavailable (scenario: E). One edit, then the journal the
// page writes every 10 seconds while storing is unavailable: `journal-unavailable.json`.

export const runE = async (browser: Browser, products: Products) => {
    const profile = await Profile.create(browser, { start: START + 7 * DAY, files: 'opfs' })
    const blank = await profile.blank()
    await profile.flags(blank, { noStorage: true })
    await blank.close()
    const tab = await profile.visit()
    await selectTool(tab, 'a', 'note')
    await tapAt(tab, 0, 4)
    await profile.clock.pass(11 * SECOND)
    await expect.poll(async () => Object.keys(await journals(tab.page, prefix)).length).toBe(1)
    const [text] = Object.values(await journals(tab.page, prefix))
    const journal = JSON.parse(text!) as { stack: { keep: number }; journalVersion: number }
    expect(journal.journalVersion).toBe(1)
    expect(journal.stack.keep).toBe(0)
    products.put('journal-unavailable.json', text!)
    await profile.close()
}
