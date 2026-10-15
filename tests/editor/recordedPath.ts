import assert from 'node:assert/strict'
import type { DrawPath } from '../../src/rendering/path'

/** Stable shape names also recognize the snapshots retained by addPath. */
export const pathName = (path: DrawPath): string => {
    const children = path.commands.flatMap((command) =>
        command[0] === 'addPath' ? [command[1]] : [],
    )
    return children.length ? children.map(pathName).join('+') : JSON.stringify(path.commands)
}

export const svgPathSource = (path: unknown) => {
    const command = (path as DrawPath).commands[0]
    assert.equal(command?.[0], 'svg')
    return command[1] as string
}

export type RecordedPath = { commands: [string, ...number[]][] }

/** Keep the historical geometry assertions while exercising the real retained path. */
export const recordPaths = () => {
    const recorded = new WeakMap<DrawPath, RecordedPath>()
    return (path: DrawPath) => {
        let result = recorded.get(path)
        if (!result) {
            const names: Record<string, string> = {
                moveTo: 'M',
                lineTo: 'L',
                quadraticCurveTo: 'Q',
                bezierCurveTo: 'C',
                rect: 'R',
                closePath: 'Z',
            }
            result = {
                commands: path.commands.map(([name, ...values]) => {
                    assert.ok(names[name], `Unexpected connector path command: ${name}`)
                    assert.ok(values.every((value) => typeof value === 'number'))
                    return [names[name], ...(values as number[])] as [string, ...number[]]
                }),
            }
            recorded.set(path, result)
        }
        return result
    }
}
