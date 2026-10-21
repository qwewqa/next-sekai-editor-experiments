import assert from 'node:assert/strict'
import test from 'node:test'
import type { FolderId, Folders } from '../../../src/chart/folders'
import { addToFolders } from '../../../src/chart/folders'
import { addToGroups, type Groups } from '../../../src/chart/groups'
import { addToStages, type Stages } from '../../../src/chart/stages'
import { normalizeName } from '../../../src/editor/workspace/manager/model'
import { createSessionDescriptor } from '../../../src/history/session'
import { captureMedia } from '../../../src/local/media'
import { canonical } from '../../../src/local/records/canonical'
import { getFilename } from '../../../src/utils/file'
import '../../helpers/lockChecks'

// Text enters well formed (§1.6.11's conventions): a lone surrogate becomes U+FFFD at every entry
// point, so no state, record, row or file holds one.

const lone = 'A\uD800B'
const fixed = 'A�B'

test('names typed in the managers, and names from level data, are well formed', () => {
    assert.equal(normalizeName(` ${lone} `), fixed)
    const groups: Groups = new Map()
    const [, group] = addToGroups(groups, lone)
    assert.equal(group, fixed)
    const stages: Stages = new Map()
    const [, stage] = addToStages(stages, `\uDC00${lone}`)
    assert.equal(stage, `�${fixed}`)
    const folders: Folders = new Map()
    const id = addToFolders(folders, new Map<FolderId, unknown>(), lone)
    assert.equal(folders.get(id)?.name, fixed)
})

test('file names and the session’s names are well formed', async () => {
    assert.equal(getFilename({ name: `${lone}.json` }), fixed)
    assert.equal(createSessionDescriptor({ sourceName: lone, name: lone }).sourceName, fixed)
    const captured = await captureMedia(new ArrayBuffer(8), { name: `${lone}.mp3`, type: '' })
    assert.equal(captured.meta.filename, `${fixed}.mp3`)
    // So a record of them always encodes.
    assert.doesNotThrow(() => canonical([captured.meta.filename]))
})
