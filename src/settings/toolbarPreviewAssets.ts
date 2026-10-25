/** The group `toolbarPreviewAssetsMigrated` looks for: the playback group before Preview Assets joined it. */
const formerPlayback = [
    'offset',
    'bgm',
    'toggleSfxVolume',
    'toggleBgmVolume',
    'speedUp',
    'speedDown',
    'stop',
    'play',
]

/**
 * The toolbar step `toolbarPreviewAssetsMigrated`: Preview Assets goes first in
 * a group that exactly matches the old default playback group, so Play stays its face. A
 * customised toolbar, or one that has the command, is left as it is.
 */
export const insertPreviewAssets = (groups: unknown[][]): unknown[][] => {
    if (groups.some((group) => group.includes('previewAssets'))) return groups
    const index = groups.findIndex(
        (group) =>
            group.length === formerPlayback.length &&
            group.every((name, at) => name === formerPlayback[at]),
    )
    if (index === -1) return groups
    return groups.map((group, i) => (i === index ? ['previewAssets', ...group] : group))
}
