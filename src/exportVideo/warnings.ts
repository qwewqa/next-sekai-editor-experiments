/**
 * What a finished export left out or changed. Times are seconds into the clip. `pictureStopped`
 * covers the frames after it, so those are not also counted in `framesMissing`.
 */
export type ExportWarning =
    /** The picture ends at `at`, before the end of the clip. */
    | { code: 'pictureStopped'; at: number }
    /** Frames within the clip that have no picture. */
    | { code: 'framesMissing'; count: number }
    /** Frames placed at another time than the encoder gave them. */
    | { code: 'timingReassigned'; count: number }
    /** The AAC encoder delay could not be measured, so an estimate placed the sound. */
    | { code: 'audioSyncEstimated' }
    /** Frames whose drawing reported a problem. */
    | { code: 'framesIncomplete'; count: number }
    /** The file's size, which differs from the one selected. */
    | { code: 'resolutionDiffers'; width: number; height: number }
    /** The sound ends at `at`, before the end of the clip. */
    | { code: 'soundStopped'; at: number }
