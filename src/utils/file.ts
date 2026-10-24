import { toWellFormed } from '../local/records/wellFormed'
import { platform } from '../platform'

export const pickFile = async () => (await platform.pickFiles({}))[0]?.file

// Only these end a name: "v1.2 final.nxsp" is "v1.2 final", and ".json.gz" goes whole.
const knownExtensions = [
    '.nxsp',
    '.nsld',
    '.json.gz',
    '.gz',
    '.json',
    '.usc',
    '.sus',
    '.zip',
    '.scp',
    '.mp3',
    '.wav',
    '.ogg',
    '.oga',
    '.opus',
    '.flac',
    '.m4a',
    '.aac',
    '.mp4',
    '.webm',
]

export const getFilename = (file: Pick<File, 'name'>) => {
    const { name } = file
    const lower = name.toLowerCase()
    const extension = knownExtensions.find((extension) => lower.endsWith(extension))
    return toWellFormed(extension ? name.slice(0, -extension.length) : name).trim()
}

export const pickFileForOpen = async (id: string) => {
    const [opened] = await platform.pickFiles({ id, handles: true })
    return { file: opened?.file, handle: opened?.handle }
}
