/**
 * A linked program of two shaders, which are deleted once linked. On a failure nothing is left,
 * and the error names `name` with the log.
 */
export const linkProgram = (
    gl: WebGL2RenderingContext,
    name: string,
    vertexShader: string,
    fragmentShader: string,
) => {
    const shaders: WebGLShader[] = []
    const program = gl.createProgram()
    try {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Allocation may fail on a lost/exhausted context despite DOM declarations.
        if (!program) throw new Error(`Failed to create ${name} shader program`)
        for (const [type, source] of [
            [gl.VERTEX_SHADER, vertexShader],
            [gl.FRAGMENT_SHADER, fragmentShader],
        ] as const) {
            const shader = gl.createShader(type)
            if (!shader) throw new Error('Failed to create shader')
            shaders.push(shader)
            gl.shaderSource(shader, source)
            gl.compileShader(shader)
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
                throw new Error(
                    `Failed to compile ${name} shader: ${gl.getShaderInfoLog(shader) ?? ''}`,
                )
            gl.attachShader(program, shader)
        }
        gl.linkProgram(program)
        if (!gl.getProgramParameter(program, gl.LINK_STATUS))
            throw new Error(
                `Failed to link ${name} shader program: ${gl.getProgramInfoLog(program) ?? ''}`,
            )
        return program
    } catch (error) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- As above.
        if (program) gl.deleteProgram(program)
        throw error
    } finally {
        for (const shader of shaders) {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- As above.
            if (program) gl.detachShader(program, shader)
            gl.deleteShader(shader)
        }
    }
}
