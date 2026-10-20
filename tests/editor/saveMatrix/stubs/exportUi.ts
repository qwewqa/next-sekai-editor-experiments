// A stand-in for src/editor/commands/exportLevel/ui.ts, whose dialogs pull in the whole editor
// through the history index. The Save core reads only `fileErrorText`; Export's follow-up dialogs
// are the harness's own `ExportUi`.
import { fileErrorKey } from '../../../../src/editor/commands/exportLevel/errorText'
import { i18n } from '../../../../src/i18n'
import type { FileError } from '../../../../src/platform'
import { interpolate } from '../../../../src/utils/interpolate'

export const fileErrorText = (name: string, error: FileError) =>
    interpolate(() => i18n.value.save[fileErrorKey(error)], error.fileName ?? name)()
