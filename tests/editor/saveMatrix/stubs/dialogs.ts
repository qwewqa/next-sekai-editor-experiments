// A stand-in for src/editor/save/dialogs.ts, whose components pull in the whole editor through
// the history index. The Save core reads `saveUi` and `replaceNewerLine`; the harness sets a
// complete `SaveUi` before every run.
import type { SaveUi } from '../../../../src/editor/save/dialogs'
import { i18n } from '../../../../src/i18n'
import { PRODUCT_NAME } from '../../../../src/product'
import { interpolate } from '../../../../src/utils/interpolate'

export let saveUi: SaveUi = {} as SaveUi

export const setSaveUiForTests = (ui: SaveUi) => {
    saveUi = ui
}

export const replaceNewerLine = () =>
    interpolate(() => i18n.value.conflict.replaceNewer, PRODUCT_NAME)()
