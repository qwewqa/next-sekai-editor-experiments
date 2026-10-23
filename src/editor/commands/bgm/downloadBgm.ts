import { FileError, platform } from '../../../platform'
import type { Bgm } from '../../../state/bgm'
import { notify } from '../../notification'
import { fileErrorText } from '../exportLevel/ui'

/** The file name a BGM downloads as: the name it was picked with, else its title and type. */
const nameOf = (bgm: Bgm) => {
    if (bgm.meta?.filename) return bgm.meta.filename
    const extension = bgm.meta?.type.split('/')[1]
    return `${bgm.filename ?? 'BGM'}${extension ? `.${extension}` : ''}`
}

/** Downloads the BGM’s original bytes through the platform’s download path, as they were picked. */
export const downloadBgm = async (bgm: Bgm) => {
    const { source } = bgm
    if (!source) return
    const name = nameOf(bgm)
    try {
        await platform.saveFile({
            kind: 'audio',
            suggestedName: name,
            build: () => Promise.resolve(new Blob([source], { type: bgm.meta?.type ?? '' })),
        })
    } catch (error) {
        if (!(error instanceof FileError)) throw error
        notify(() => fileErrorText(name, error), { card: true, severity: 'error' })
    }
}
