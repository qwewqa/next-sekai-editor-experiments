import { gzip, ungzip } from 'pako'

/** Whether this browser gzips on streams; Firefox before 113 does not. */
export const hasGzipStreams = () =>
    typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined'

/** Gzip on the browser's stream, which does not hold the main thread; the browser picks the level. */
export const gzipOnStream = (text: string) =>
    new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob()

/** Gzip at level 9 in script, the same bytes in every browser. */
export const gzipLevel9 = (text: string) => new Blob([gzip(text, { level: 9 })])

/** Gzipped text: on the browser's stream where there is one, else at level 9 in script. */
export const gzipText = (text: string) =>
    hasGzipStreams() ? gzipOnStream(text) : Promise.resolve(gzipLevel9(text))

/** The bytes of gzipped data; it rejects when they are not gzip. */
export const gunzipBlob = async (blob: Blob) =>
    hasGzipStreams()
        ? new Uint8Array(
              await new Response(
                  blob.stream().pipeThrough(new DecompressionStream('gzip')),
              ).arrayBuffer(),
          )
        : ungzip(new Uint8Array(await blob.arrayBuffer()))
