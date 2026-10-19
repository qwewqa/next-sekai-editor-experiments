import { createHistoryOperation } from './createHistoryOperation'
import { captureName } from './operations'
import { markFileEvent } from './stack'

export const markExported = (fileName: string, delivery: 'file' | 'download') => {
    markFileEvent(
        'export',
        createHistoryOperation({
            id: 'nse.file.export',
            data: { file: captureName(fileName), delivery },
        }),
    )
}

export const markSaved = (fileName: string, download: boolean) => {
    markFileEvent(
        'save',
        createHistoryOperation({
            id: 'nse.file.save',
            data: { file: captureName(fileName), delivery: download ? 'download' : 'file' },
        }),
        false,
    )
}
