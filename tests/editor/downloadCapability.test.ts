import assert from 'node:assert/strict'
import test from 'node:test'
import { confirmDownloads } from '../../src/editor/file/flags'
import { bindFile, downloadNotConfirmed } from '../../src/editor/file/state'
import { setPlatformForTests } from '../../src/platform'
import { createMockPlatform } from '../../src/platform/mock'

// "Download not confirmed" on every download follows the `unconfirmedDownloads` capability
// (Part 0 §0.9.1), not the operating system: the apps and the web read the same flag.

test('a download stays unconfirmed where the platform says so, even after one was confirmed', () => {
    confirmDownloads()
    bindFile({ name: 'a.nxsp', event: 'downloaded' })
    setPlatformForTests(
        createMockPlatform({ os: 'windows', capabilities: { unconfirmedDownloads: true } }),
    )
    assert.equal(downloadNotConfirmed.value, true)
    setPlatformForTests(undefined)
})

test('a download is confirmed once one was, where the platform does not say otherwise', () => {
    confirmDownloads()
    bindFile({ name: 'b.nxsp', event: 'downloaded' })
    setPlatformForTests(
        createMockPlatform({ os: 'ios', capabilities: { unconfirmedDownloads: false } }),
    )
    assert.equal(downloadNotConfirmed.value, false)
    setPlatformForTests(undefined)
})
