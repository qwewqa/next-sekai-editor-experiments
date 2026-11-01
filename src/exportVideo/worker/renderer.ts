import { drawPreviewFrame } from '../../preview/drawFrame'
import { createPreviewChartBuilder } from '../../preview/engine/chart'
import { createPreviewRenderer } from '../../preview/gl'
import { linkProgram } from '../../preview/program'
import { createRenderTarget } from '../../preview/renderTarget'
import { applyMirror } from '../../preview/worker/mirror'
import { frameTimestamp } from '../timing'
import { closeExportAssets, type ExportSettings, type ExportStart } from '../types'

export class GraphicsError extends Error {}

export const createExportRenderer = (start: ExportStart, fail: (error: unknown) => void) => {
    const { settings: s, assets } = start
    const canvas = new OffscreenCanvas(s.width, s.height)
    const renderer = (() => {
        try {
            return createPreviewRenderer(canvas, false)
        } catch (error) {
            closeExportAssets(assets)
            throw new GraphicsError(String(error))
        }
    })()
    const gl = canvas.getContext('webgl2')
    if (!gl) {
        renderer.dispose()
        closeExportAssets(assets)
        throw new GraphicsError('WebGL2 is unavailable')
    }
    let composite: ReturnType<typeof createRenderTarget> | undefined
    let fade: WebGLProgram | undefined
    const lost = () => {
        fail(new GraphicsError('Export graphics context was lost'))
    }
    const restored = () => {
        fail(new GraphicsError('Export graphics context was restored after loss'))
    }
    canvas.addEventListener('webglcontextlost', lost)
    canvas.addEventListener('webglcontextrestored', restored)
    const dispose = () => {
        canvas.removeEventListener('webglcontextlost', lost)
        canvas.removeEventListener('webglcontextrestored', restored)
        composite?.dispose()
        if (fade) gl.deleteProgram(fade)
        renderer.dispose()
    }
    try {
        renderer.setTexture(0, assets.skin.texture, assets.skin.interpolation)
        if (assets.particle)
            renderer.setTexture(1, assets.particle.texture, assets.particle.interpolation)
        if (assets.background) renderer.setTexture(3, assets.background.texture, true)
        fade = linkProgram(
            gl,
            'export fade',
            `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`,
            `#version 300 es
precision highp float;
uniform float u_alpha;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, u_alpha); }`,
        )
        const alpha = gl.getUniformLocation(fade, 'u_alpha')
        const build = createPreviewChartBuilder()
        const mirror = applyMirror(undefined, start.mirror)
        const draw = (time: number, clipTime?: number, settings: ExportSettings = s) => {
            const s = settings
            const width = Math.round(s.width * s.renderScale)
            const height = Math.round(s.height * s.renderScale)
            renderer.setRenderTarget({ width, height, antialias: s.antialias })
            if (
                s.renderScale !== 1 &&
                (composite?.width !== width || composite.height !== height)
            ) {
                composite?.dispose()
                composite = createRenderTarget(gl, canvas, { width, height, antialias: false })
            }
            renderer.setCompositeTarget(s.renderScale === 1 ? undefined : composite)
            const chart = build(mirror, s.noteSpeed)
            const background = assets.background
            const result = drawPreviewFrame(
                renderer,
                undefined,
                assets.skin.skin,
                assets.particle?.particle,
                chart,
                {
                    time,
                    leftLimit: false,
                    width,
                    height,
                    displayWidth: (540 * s.width) / s.height,
                    displayHeight: 540,
                    overlayWidth: width,
                    overlayHeight: height,
                    noteSpeed: s.noteSpeed,
                    showEffects: s.showEffects,
                    showHitboxes: false,
                    showCombo: s.showCombo,
                    backdrop: s.backdrop,
                    background: background && {
                        ...background,
                        sigma: (background.blur * height) / 540,
                    },
                },
                undefined,
            )
            if (!result.drawn)
                throw new GraphicsError(`Export frame was not drawn: ${result.reason}`)
            const opacity =
                clipTime === undefined
                    ? 0
                    : 1 -
                      Math.max(
                          0,
                          Math.min(
                              1,
                              s.fadeIn ? clipTime / s.fadeIn : 1,
                              s.fadeOut ? (s.frames / s.frameRate - clipTime) / s.fadeOut : 1,
                          ),
                      )
            if (opacity > 0) {
                gl.useProgram(fade ?? null)
                gl.enable(gl.BLEND)
                gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
                gl.uniform1f(alpha, opacity)
                gl.drawArrays(gl.TRIANGLES, 0, 3)
            }
            if (s.renderScale !== 1) composite?.present(s.width, s.height)
            if (!renderer.checkError())
                throw new GraphicsError('Export frame failed its graphics check')
        }
        return {
            canvas,
            dispose,
            draw,
            capture(index: number) {
                draw(s.in + index / s.frameRate, index / s.frameRate)
                // Capture before yielding; the drawing buffer need not survive another task.
                return new VideoFrame(canvas, {
                    timestamp: frameTimestamp(index, s.frameRate),
                    duration:
                        frameTimestamp(index + 1, s.frameRate) - frameTimestamp(index, s.frameRate),
                    alpha: 'discard',
                })
            },
            pixels() {
                gl.bindFramebuffer(gl.FRAMEBUFFER, null)
                const pixels = new Uint8Array(s.width * s.height * 4)
                gl.readPixels(0, 0, s.width, s.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
                if (!renderer.checkError())
                    throw new GraphicsError('Export frame could not be read')
                return pixels
            },
            loseContext() {
                gl.getExtension('WEBGL_lose_context')?.loseContext()
            },
        }
    } catch (error) {
        dispose()
        throw new GraphicsError(String(error))
    } finally {
        closeExportAssets(assets)
    }
}
