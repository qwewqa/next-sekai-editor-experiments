declare const libtess: {
    GluTesselator: new () => {
        gluTessProperty(which: number, value: number): void
        gluTessNormal(x: number, y: number, z: number): void
        gluTessCallback(which: 100104, callback: (edge: boolean) => void): void
        gluTessCallback(
            which: 100107,
            callback: (point: [number, number], output: number[]) => void,
        ): void
        gluTessCallback(
            which: 100105,
            callback: (coords: [number, number, number]) => [number, number],
        ): void
        gluTessCallback(which: 100103, callback: (error: number) => void): void
        gluTessBeginPolygon(data?: unknown): void
        gluTessBeginContour(): void
        gluTessVertex(coords: number[], data: number[]): void
        gluTessEndContour(): void
        gluTessEndPolygon(): void
    }
    gluEnum: {
        GLU_TESS_EDGE_FLAG: 100104
        GLU_TESS_VERTEX_DATA: 100107
        GLU_TESS_COMBINE: 100105
        GLU_TESS_ERROR: 100103
        GLU_TESS_WINDING_RULE: 100140
    }
    windingRule: { GLU_TESS_WINDING_ODD: 100130; GLU_TESS_WINDING_NONZERO: 100131 }
}
export default libtess
