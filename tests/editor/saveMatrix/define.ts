import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isKnown, KNOWN } from './known'
import { cells, runCell, type CellResult } from './matrix'

// A matrix file: runs the cells of some paths, fails on any violation the known list does not
// name, and states each known violation as a `todo` test that turns green when it is fixed.

export const defineMatrix = (pathIds: string[]) => {
    const results: CellResult[] = []
    test(`fault matrix: ${pathIds.join(', ')}`, async () => {
        for (const { path, plan, fault } of cells())
            if (pathIds.includes(path.id)) results.push(await runCell(path, plan, fault))
        assert.ok(results.length > 0)
        const unexpected = results.flatMap((cell) =>
            cell.violations
                .filter((v) => !v.invariant.startsWith('info:') && !isKnown(cell, v))
                .map((v) => `${cell.id}: ${v.invariant}: ${v.detail}`),
        )
        assert.deepEqual(unexpected, [], 'invariant violations the known list does not name')
    })
    for (const known of KNOWN) {
        if (!known.paths.some((path) => pathIds.includes(path))) continue
        test(
            `${known.id}: ${known.title}`,
            {
                todo:
                    known.kind === 'bug'
                        ? 'a bug today (work/arch/spec-B.md)'
                        : known.kind === 'accepted'
                          ? 'an accepted residual'
                          : 'by design today',
            },
            () => {
                const found = results
                    .filter(
                        (cell) =>
                            known.paths.includes(cell.path) &&
                            cell.fault === known.fault &&
                            (known.plans?.includes(cell.plan) ?? true),
                    )
                    .flatMap((cell) =>
                        cell.violations
                            .filter(
                                (v) =>
                                    v.invariant === known.invariant &&
                                    (known.detail?.test(v.detail) ?? true),
                            )
                            .map((v) => `${cell.id}: ${v.detail}`),
                    )
                assert.deepEqual(found, [])
            },
        )
    }
}
