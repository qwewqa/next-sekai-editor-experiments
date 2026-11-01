import { expect, test } from '@playwright/test'
import type { HelpSectionDef } from '../../src/editor/help/content'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Help explains every built-in command in an entry, or lists it as needing none, so a new
// command has to be placed in one of the two.

test('every built-in command is in exactly one entry or on the no-entry list', async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    const result = await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const { commands } = await appImport<typeof import('../../src/editor/commands')>(
            '/src/editor/commands/index.ts',
        )
        const { helpSections, NO_ENTRY } = await appImport<
            typeof import('../../src/editor/help/content')
        >('/src/editor/help/content.ts')
        const sections: readonly HelpSectionDef[] = helpSections
        const entries = sections.flatMap((section) => section.entries)
        const owners = new Map<string, number>()
        for (const name of [...entries.flatMap((entry) => entry.commands ?? []), ...NO_ENTRY])
            owners.set(name, (owners.get(name) ?? 0) + 1)
        const names = Object.keys(commands)
        const ids = entries.map((entry) => entry.id)
        return {
            notOnce: names.filter((name) => owners.get(name) !== 1),
            unknown: [...owners.keys()].filter((name) => !names.includes(name)),
            duplicateIds: ids.filter((id, i) => ids.indexOf(id) !== i),
        }
    })
    expect(result).toEqual({ notOnce: [], unknown: [], duplicateIds: [] })
})
