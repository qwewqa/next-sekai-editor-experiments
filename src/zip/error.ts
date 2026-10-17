export type ZipErrorCode =
    | 'not-zip'
    | 'directory'
    | 'unsupported'
    | 'truncated'
    | 'header'
    | 'crc'
    | 'size'
    | 'inflate'
    | 'too-large'
    | 'limit'
    | 'ambiguous'

/** A ZIP that cannot be read (damaged or unsupported), or a write past what the writer supports. */
export class ZipError extends Error {
    constructor(
        readonly code: ZipErrorCode,
        message: string = code,
    ) {
        super(message)
        this.name = 'ZipError'
    }
}
