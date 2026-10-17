import { firefox } from '@playwright/test'

const base = { 'webgl.disabled': false, 'webgl.force-enabled': true, 'webgl.enable-webgl2': true }
const variants = {
    none: {},
    forced: base,
    software: { ...base, 'gfx.webrender.software': true },
    noEgl: { ...base, 'gfx.x11-egl.force-disabled': true },
    softwareNoEgl: { ...base, 'gfx.webrender.software': true, 'gfx.x11-egl.force-disabled': true },
}
for (const headless of [true, false]) {
    for (const [name, prefs] of Object.entries(variants)) {
        const b = await firefox.launch({ headless, firefoxUserPrefs: prefs })
        const p = await b.newPage()
        const r = await p.evaluate(() => {
            const gl = document
                .createElement('canvas')
                .getContext('webgl2', { stencil: true, antialias: true, preserveDrawingBuffer: true })
            return gl ? String(gl.getParameter(gl.VERSION)) : null
        })
        console.log(headless ? 'headless' : 'headed', name, r)
        await b.close()
    }
}
