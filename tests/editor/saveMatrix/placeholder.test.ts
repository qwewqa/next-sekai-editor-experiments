import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SaveDialogInput } from '../../../src/editor/save/dialogs'
import { createWorld, flow, settle, type Setup, type World } from './world'

// An empty File Name field saves its placeholder, so the placeholder is suggested as a name is,
// numbered past any file that a stored binding has. An untitled chart's empty field used to save
// Untitled.nxsp while another chain was bound to it, and the Save took that file over.

type Case = {
    label: string
    setup: Setup
    run: (w: World) => Promise<void>
    name: string
    placeholder: string
}

const cases: Case[] = [
    {
        label: 'the first Save of an untitled chart',
        setup: { own: 'unbound', otherFile: 'Untitled.nxsp' },
        run: () => flow.save(),
        name: '',
        placeholder: 'Untitled (2)',
    },
    {
        label: 'Save As of an untitled chart',
        setup: { own: 'unbound', otherFile: 'Untitled.nxsp' },
        run: () => flow.saveAs(),
        name: '',
        placeholder: 'Untitled (2)',
    },
    {
        label: "the not-found dialog's Save As",
        setup: { own: 'missing', otherFile: 'Untitled.nxsp' },
        run: (w) => {
            w.answers.notFound.push('saveAs')
            return flow.save()
        },
        name: 'own (2)',
        placeholder: 'Untitled (2)',
    },
    {
        // The open chain is bound to Untitled.nxsp, and the session being saved has no name.
        label: "Recent Sessions' Save of an untitled session",
        setup: { ownFile: 'Untitled.nxsp', other: false },
        run: () => flow.saveToFile('session-other'),
        name: '',
        placeholder: 'Untitled (2)',
    },
    {
        label: 'Save As with Untitled and Untitled (2) both bound',
        setup: { ownFile: 'Untitled (2).nxsp', otherFile: 'Untitled.nxsp' },
        run: () => flow.saveAs(),
        name: 'Untitled (3)',
        placeholder: 'Untitled (3)',
    },
    {
        // A download takes nothing over, and the browser renames a clash.
        label: 'the first Save where Save downloads',
        setup: { platform: 'download', own: 'unbound', otherFile: 'Untitled.nxsp' },
        run: () => flow.save(),
        name: '',
        placeholder: 'Untitled',
    },
]

for (const { label, setup, run, name, placeholder } of cases)
    test(`${label}: File Name is "${name}" with the placeholder "${placeholder}"`, async () => {
        const w = await createWorld(setup)
        const shown: Pick<SaveDialogInput, 'name' | 'placeholder'>[] = []
        w.on('ui:saveDialog', (_n, input) => {
            const { name, placeholder } = input as SaveDialogInput
            shown.push({ name, placeholder })
        })
        // The dialog is cancelled, so nothing is written.
        await run(w)
        await settle()
        assert.deepEqual(shown, [{ name, placeholder }])
        assert.deepEqual(w.writes, [])
    })

// An opened "coconut (3).nxsp" whose revision recorded "coconut.nxsp" keeps the handle's name as
// its binding, for reading and identifying the file. A first Save that downloads suggests the
// recorded name, as it does where no handle was kept, so repeated downloads don't drift.
for (const [label, downloadName, name] of [
    ['with the recorded name', 'coconut.nxsp', 'coconut'],
    ['without one (control)', undefined, 'coconut (3)'],
] as const)
    test(`a first Save that downloads an opened file kept with a handle, ${label}: File Name is "${name}"`, async () => {
        const w = await createWorld({ ownFile: 'coconut (3).nxsp' })
        w.filePicker.choice = 'disabled'
        const chain = w.chains.get('chain-own')!
        chain.file = {
            ...(chain.file as object),
            event: 'opened',
            ...(downloadName ? { downloadName } : {}),
        }
        const shown: string[] = []
        w.on('ui:saveDialog', (_n, input) => {
            shown.push((input as SaveDialogInput).name)
        })
        await flow.save()
        await settle()
        assert.deepEqual(shown, [name])
        assert.deepEqual(w.writes, [])
    })
