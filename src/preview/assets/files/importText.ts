import { formatSize } from '../../../editor/commands/exportLevel/format'
import { i18n } from '../../../i18n'
import { formatCount } from '../../../utils/size'
import { AssetImportError } from './errors'
import { formatImportMessage } from './importMessage'

const number = (value: number) => formatCount(value)

/** The plain message for a package that is refused (Part 2, 2.5.5), in the current language. */
export const importMessage = (error: AssetImportError) => {
    const { import: text, part, noun } = i18n.value.commands.previewAssets
    return formatImportMessage(error, { import: text, part, noun }, number, formatSize)
}
