import { installExportWorker } from '../../exportVideo/worker/export.worker'
import { openMuxOutput } from '../../exportVideo/worker/mux'

installExportWorker(openMuxOutput)
