/** Keeps the decoded atlas's colour and alpha when making an independent copy. */
export const copyAtlasBitmap = async (bitmap: ImageBitmap) =>
    createImageBitmap(bitmap, {
        premultiplyAlpha: 'premultiply',
        colorSpaceConversion: 'none',
    })
