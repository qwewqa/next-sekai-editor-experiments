const table = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
}

/** The zlib CRC-32. Pass the previous result as `crc` to continue over more data. */
export const crc32 = (data: Uint8Array, crc = 0) => {
    let c = ~crc
    for (const byte of data) c = (table[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
    return ~c >>> 0
}
