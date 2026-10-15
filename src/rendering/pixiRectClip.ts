import {
    ExtensionType,
    extensions,
    type Container,
    type Effect,
    type Instruction,
    type InstructionPipe,
    type InstructionSet,
    type WebGLRenderer,
} from 'pixi.js'

export type PixelBounds = readonly [left: number, top: number, right: number, bottom: number]

/** Integer render-surface clips need no antialiasing or stencil attachment. */
export class PixelRectClip implements Effect {
    readonly pipe = 'editorPixelRectClip'
    readonly priority = 0

    constructor(readonly bounds: PixelBounds) {}

    destroy() {
        // The effect owns no resources; its container owns its lifetime.
    }
}

type RectInstruction = Instruction &
    ({ action: 'push'; clip: PixelRectClip; container: Container } | { action: 'pop' })

/**
 * Pixi 8 exports ScissorMask but does not implement its WebGL pipe. This small
 * editor-only pipe handles integer clips on atlas/scratch surfaces. Scene clips
 * with fractional edges or arbitrary shapes keep Pixi's normal stencil mask.
 */
class PixelRectClipPipe implements InstructionPipe<RectInstruction> {
    static readonly extension = {
        type: ExtensionType.WebGLPipes,
        name: 'editorPixelRectClip',
    } as const

    private readonly stack: PixelBounds[] = []

    constructor(private readonly renderer: WebGLRenderer) {
        renderer.runners.prerender.add(this)
        renderer.runners.postrender.add(this)
    }

    prerender() {
        if (this.stack.length) this.renderer.gl.disable(this.renderer.gl.SCISSOR_TEST)
        this.stack.length = 0
    }

    postrender() {
        if (this.stack.length) this.renderer.gl.disable(this.renderer.gl.SCISSOR_TEST)
        this.stack.length = 0
    }

    push(effect: Effect, container: Container, instructions: InstructionSet) {
        this.renderer.renderPipes.batch.break(instructions)
        const instruction: RectInstruction = {
            renderPipeId: 'editorPixelRectClip',
            action: 'push',
            clip: effect as PixelRectClip,
            container,
            canBundle: false,
        }
        instructions.add(instruction)
    }

    pop(_clip: Effect, _container: Container, instructions: InstructionSet) {
        this.renderer.renderPipes.batch.break(instructions)
        instructions.add({
            renderPipeId: 'editorPixelRectClip',
            action: 'pop',
            canBundle: false,
        } satisfies RectInstruction)
    }

    execute(instruction: RectInstruction) {
        const gl = this.renderer.gl
        if (instruction.action === 'push') {
            const [left, top, right, bottom] = instruction.clip.bounds
            const transform = instruction.container.worldTransform
            // Surface clip groups have identity transforms except for the
            // integer origin of a bounded opacity layer.
            const parent = this.stack.at(-1)
            this.stack.push([
                Math.max(parent?.[0] ?? -Infinity, left + transform.tx),
                Math.max(parent?.[1] ?? -Infinity, top + transform.ty),
                Math.min(parent?.[2] ?? Infinity, right + transform.tx),
                Math.min(parent?.[3] ?? Infinity, bottom + transform.ty),
            ])
        } else {
            this.stack.pop()
        }
        const bounds = this.stack.at(-1)
        if (!bounds) {
            gl.disable(gl.SCISSOR_TEST)
            return
        }
        const target = this.renderer.renderTarget.renderTarget
        const resolution = target.resolution
        // Clamp before GL's integer conversion: even a far-off empty clip must
        // not overflow scissor coordinates or dimensions.
        const left = Math.max(0, Math.min(target.pixelWidth, bounds[0] * resolution))
        const top = Math.max(0, Math.min(target.pixelHeight, bounds[1] * resolution))
        const right = Math.max(left, Math.min(target.pixelWidth, bounds[2] * resolution))
        const bottom = Math.max(top, Math.min(target.pixelHeight, bounds[3] * resolution))
        gl.enable(gl.SCISSOR_TEST)
        // Pixi renders textures with their Y axis flipped relative to the root.
        gl.scissor(
            left,
            target.isRoot ? target.pixelHeight - bottom : top,
            Math.max(0, right - left),
            Math.max(0, bottom - top),
        )
    }

    destroy() {
        this.renderer.runners.prerender.remove(this)
        this.renderer.runners.postrender.remove(this)
        this.stack.length = 0
    }
}

extensions.add(PixelRectClipPipe)
