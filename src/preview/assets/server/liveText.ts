import { formatSize } from '../../../editor/commands/exportLevel/format'
import { i18n } from '../../../i18n'
import { formatCount } from '../../../utils/size'
import type { AssetImportError } from '../files/errors'
import type { ServerChooserError } from './chooser'
import { serverErrorText, serverItemMessage, type ServerStrings } from './text'

const number = (value: number) => formatCount(value)

const strings = (): ServerStrings => {
    const {
        import: text,
        part,
        noun,
        server,
        serverImport,
        offline,
    } = i18n.value.commands.previewAssets
    return { import: text, part, noun, server, serverImport, offline }
}

/** The plain message for a server item that is refused, in the current language. */
export const serverItemText = (error: AssetImportError) =>
    serverItemMessage(error, strings(), number, formatSize)

/** What the chooser says about a failure, in the current language. */
export const serverFailureText = (error: ServerChooserError) => serverErrorText(error, strings())
