import { installExportWorker } from './export.worker'
import { openMuxOutput } from './mux'

installExportWorker(openMuxOutput)
