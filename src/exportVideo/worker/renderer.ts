import { drawPreviewFrame } from '../../preview/drawFrame'
import { createPreviewChartBuilder } from '../../preview/engine/chart'
import { createPreviewRenderer } from '../../preview/gl'
import { linkProgram } from '../../preview/program'
import { createRenderTarget } from '../../preview/renderTarget'
import { applyMirror } from '../../preview/worker/mirror'
import { frameTimestamp } from '../timing'
import { closeExportAssets, type ExportScene, type ExportSettings } from '../types'
import { STRIPES } from './encoderColor'

export class GraphicsError extends Error {}

export const createExportRenderer = (scene: ExportScene, fail: (error: unknown) => void) => {
    const { settings: s, assets } = scene
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
    // A restored context has lost its resources, so the renderer stays unusable.
    let wasLost = false
    const lost = () => {
        wasLost = true
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
        const mirror = applyMirror(undefined, scene.mirror)
        /** Whether the drawn frame passes the graphics check. Throws when it cannot be drawn. */
        const draw = (time: number, clipTime?: number, settings: ExportSettings = s) => {
            try {
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
                if (gl.isContextLost()) throw new GraphicsError('Export graphics context was lost')
                return renderer.checkError()
            } catch (error) {
                throw error instanceof GraphicsError ? error : new GraphicsError(String(error))
            }
        }
        return {
            canvas,
            dispose,
            draw,
            /**
             * Draws and captures one frame. A frame that fails the graphics check after drawing
             * is still captured, as incomplete. Throws when the frame cannot be drawn or captured.
             */
            capture(index: number) {
                if (wasLost || gl.isContextLost())
                    throw new GraphicsError('Export graphics context was lost')
                const complete = draw(s.in + index / s.frameRate, index / s.frameRate)
                // Capture before yielding; the drawing buffer need not survive another task.
                const frame = new VideoFrame(canvas, {
                    timestamp: frameTimestamp(index, s.frameRate),
                    duration:
                        frameTimestamp(index + 1, s.frameRate) - frameTimestamp(index, s.frameRate),
                    alpha: 'discard',
                })
                return { frame, complete }
            },
            /** Draws STRIPES between `edges` and captures them as `capture` does. */
            captureStripes: (edges: readonly number[]) => {
                if (canvas.width !== s.width) canvas.width = s.width
                if (canvas.height !== s.height) canvas.height = s.height
                gl.bindFramebuffer(gl.FRAMEBUFFER, null)
                gl.enable(gl.SCISSOR_TEST)
                for (const [i, [r, g, b]] of STRIPES.entries()) {
                    const x = edges[i] ?? 0
                    gl.scissor(x, 0, (edges[i + 1] ?? x) - x, s.height)
                    gl.clearColor(r / 255, g / 255, b / 255, 1)
                    gl.clear(gl.COLOR_BUFFER_BIT)
                }
                gl.disable(gl.SCISSOR_TEST)
                return new VideoFrame(canvas, { timestamp: 0, alpha: 'discard' })
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
