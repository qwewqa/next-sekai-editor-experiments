import { watch, type WatchSource } from 'vue'

/**
 * One remembered answer, reused while its key matches part by part. It is dropped when `held`
 * changes, so it never keeps a state the editor has left, nor the audio that state holds.
 */
export const createPointMemo = <T>(held: WatchSource) => {
    let remembered: { key: readonly unknown[]; value: T } | undefined
    watch(
        held,
        () => {
            remembered = undefined
        },
        { flush: 'sync' },
    )
    return (key: readonly unknown[], find: () => T): T => {
        if (remembered?.key.every((value, i) => value === key[i])) return remembered.value
        const value = find()
        remembered = { key, value }
        return value
    }
}
