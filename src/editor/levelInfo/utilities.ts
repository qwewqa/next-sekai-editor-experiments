import { showModal } from '../../modals'
import CoverEditorModal from '../utilities/coverEditor/CoverEditorModal.vue'
import PreviewEditorModal from '../utilities/previewEditor/PreviewEditorModal.vue'
import type { UtilityResult } from './picked'

// Cover Editor and Preview Editor opened over Level Info: Generate hands the
// result back instead of downloading it, and closing without Generate returns nothing.

/** The cover editor started from `image`. */
export const editCover = (image: Blob): Promise<UtilityResult | undefined> =>
    showModal(CoverEditorModal, { start: image, apply: true })

/** The preview editor, from the BGM or a file it is given. */
export const makePreview = (): Promise<UtilityResult | undefined> =>
    showModal(PreviewEditorModal, { apply: true })
