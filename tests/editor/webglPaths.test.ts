import assert from 'node:assert/strict'
import test from 'node:test'
import { DrawPath } from '../../src/rendering/path'
import { PathGraphicsCache } from '../../src/rendering/pathGraphics'

// Geometry and snapshot behavior formerly inspected through CanvasKit now live
// in pathRecording, pathSvg, pixiPathGraphics and the native browser oracle.
// These working-set regressions exercise the selected renderer's actual cache.
test('a dense frame of small connector paths stays compiled on the next complete draw', () => {
    const cache = new PathGraphicsCache()
    try {
        const paths = Array.from({ length: 1000 }, (_, i) => {
            const path = new DrawPath()
            path.moveTo(i, 0)
            path.lineTo(i + 0.2, 1)
            path.lineTo(i + 1.2, 1)
            path.lineTo(i + 1, 0)
            path.closePath()
            return path
        })
        cache.beginFrame()
        const resources = paths.map((path) =>
            cache.get(path, { color: 0xffffff }, false, 'nonzero', 'white'),
        )
        cache.endFrame()
        const builds = cache.stats.native + cache.stats.fallback
        assert.equal(builds, paths.length)
        cache.beginFrame()
        for (const [index, path] of paths.entries())
            assert.equal(
                cache.get(path, { color: 0xffffff }, false, 'nonzero', 'white'),
                resources[index],
            )
        cache.endFrame()
        assert.equal(
            cache.stats.native + cache.stats.fallback,
            builds,
            'a full scan must not churn',
        )
        assert.equal(cache.stats.hits, paths.length)
        assert.equal(cache.stats.evictions, 0)
    } finally {
        cache.destroy()
    }
})

test('discarded paths have a bounded compiled lifetime without waiting for garbage collection', () => {
    const budget = 32 * 1024
    const cache = new PathGraphicsCache(budget)
    let live = 0
    let entryBytes = 0
    try {
        for (let i = 0; i < 10_000; i++) {
            cache.beginFrame()
            const path = new DrawPath()
            path.rect(i, 0, 1, 1)
            const resource = cache.get(path, { color: 0 }, false, 'nonzero', 'black')
            entryBytes ||= cache.retainedBytes
            live++
            const destroy = resource.destroy.bind(resource)
            let destroyed = false
            resource.destroy = () => {
                assert.equal(destroyed, false, 'compiled resources are released once')
                destroyed = true
                live--
                destroy()
            }
            cache.endFrame()
            assert.ok(cache.retainedBytes <= budget)
            assert.ok(
                live <= Math.floor(budget / entryBytes) + 1,
                'old frames release native resources',
            )
        }
    } finally {
        cache.destroy()
    }
    assert.equal(live, 0, 'shutdown releases the entire compiled cache')
    assert.equal(cache.retainedBytes, 0)
})
