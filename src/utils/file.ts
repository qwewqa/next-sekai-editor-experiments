import { platform } from '../platform'

export const pickFile = async () => (await platform.pickFiles({}))[0]?.file

export const getFilename = (file: File) => file.name.split('.')[0]?.trim()

export const pickFileForOpen = async (id: string) => {
    const [opened] = await platform.pickFiles({ id, handles: true })
    return { file: opened?.file, handle: opened?.handle }
}
