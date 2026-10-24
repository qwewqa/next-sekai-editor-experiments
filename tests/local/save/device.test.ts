import assert from 'node:assert/strict'
import test from 'node:test'
import { documentDeviceId } from '../../../src/local/deviceId'
import { readNxsp } from '../../../src/local/nxsp/read'
import { checkFiles, DEVICE, Fixture, hasUv, save } from './fixture'

// The device a Save records is per document (§1.3.3): derived from this install's `deviceId` and
// the chain's lineage, in `project.json` and in the file's own `save` entry alike.

/** A chain with one edit, stored, under `lineageId`. */
const chainOf = async (seed: number, lineageId: string) => {
    const fixture = await Fixture.create(seed)
    await fixture.putChain({ lineageId })
    await fixture.storeMedia()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.flush()
    return fixture
}

/** The file's revision device and its last entry's, which the checker requires to agree. */
const devicesOf = async (blob: Blob) => {
    const read = await readNxsp(blob)
    if (read.kind !== 'nxsp' || !read.project?.revision || !read.history)
        throw new Error('A file with a revision and history is needed')
    return { revision: read.project.revision.device, last: read.history.entries.at(-1)?.device }
}

test('two documents saved by one install record different devices, neither its deviceId', async () => {
    const a = await chainOf(91, 'lineage-a')
    const b = await chainOf(92, 'lineage-b')
    const savedA = await save(a, { kind: 'copy' })
    const savedB = await save(b, { kind: 'copy' })
    assert.ok(savedA.file && savedB.file)
    const deviceA = await devicesOf(savedA.file)
    const deviceB = await devicesOf(savedB.file)

    assert.deepEqual(deviceA.revision, {
        id: documentDeviceId(DEVICE.deviceId, 'lineage-a'),
        label: 'Web (Chrome)',
    })
    assert.deepEqual(deviceA.last, deviceA.revision)
    assert.deepEqual(deviceB.last, deviceB.revision)
    assert.notEqual(deviceA.revision.id, deviceB.revision.id)
    for (const device of [deviceA.revision, deviceB.revision])
        assert.notEqual(device.id, DEVICE.deviceId)
    // The entry the Save core commits with the binding is the file's.
    assert.ok(!('refused' in savedA.built))
    assert.deepEqual(savedA.built.saveEntry.device, deviceA.revision)

    if (hasUv) {
        const checked = await checkFiles([savedA.file, savedB.file])
        assert.equal(checked.status, 0, checked.output)
    }
})

test('Save As… keeps the lineage, so its file records the device the chain’s first Save did', async () => {
    const fixture = await chainOf(93, 'lineage-c')
    const first = await save(fixture, { kind: 'copy' })
    await fixture.edit(2)
    await fixture.flush()
    const saveAs = await save(fixture, { kind: 'new', docId: 'doc-save-as' })
    assert.ok(first.file && saveAs.file)
    const before = await devicesOf(first.file)
    const after = await devicesOf(saveAs.file)
    assert.equal(after.revision.id, before.revision.id)
    // Both of this chain's `save` entries in the Save As… file carry it.
    const read = await readNxsp(saveAs.file)
    assert.ok(read.kind === 'nxsp' && read.history)
    const saves = read.history.entries.filter((entry) => entry.kind === 'save')
    assert.equal(saves.length, 2)
    for (const entry of saves) assert.equal(entry.device?.id, before.revision.id)
})
