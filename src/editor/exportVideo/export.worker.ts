import { installExportWorker } from '../../exportVideo/worker/export.worker'

// The page's export worker. It draws the dialog's frames; the container muxer that writes the
// file plugs in here as the `open` function.
installExportWorker(() => Promise.reject(new Error('Video files cannot be written yet')))
