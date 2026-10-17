import { i18n } from '../../../i18n'
import { languageTag } from '../../../i18n/plural'
import { settings } from '../../../settings'
import type { AssetImportError } from '../files/errors'
import type { ServerChooserError } from './chooser'
import { serverErrorText, serverItemMessage, type ServerStrings } from './text'

const number = (value: number) => new Intl.NumberFormat(languageTag(settings.locale)).format(value)

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
    serverItemMessage(error, strings(), number)

/** What the chooser says about a failure, in the current language. */
export const serverFailureText = (error: ServerChooserError) => serverErrorText(error, strings())
