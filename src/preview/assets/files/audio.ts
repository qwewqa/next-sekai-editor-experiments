/**
 * Decodes a clip to check it, off any playback context: the dialog needs no audio to be running.
 * One throwaway context per clip, since decoding resamples to the context's rate.
 */
export const decodeToCheck = (data: ArrayBuffer) =>
    new OfflineAudioContext(1, 1, 44100).decodeAudioData(data)
