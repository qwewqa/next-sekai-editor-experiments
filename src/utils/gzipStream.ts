/** Gzip on the browser's stream, which does not hold the main thread; the browser picks the level. */
export const gzipText = (text: string) =>
    new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob()

/** The bytes of gzipped data; it rejects when they are not gzip. */
export const gunzipBlob = async (blob: Blob) =>
    new Uint8Array(
        await new Response(
            blob.stream().pipeThrough(new DecompressionStream('gzip')),
        ).arrayBuffer(),
    )
