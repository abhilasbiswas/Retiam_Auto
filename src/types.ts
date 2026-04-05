// TypeScript Definition for WebGPU Raytracer

export interface Material {
    color: number[];
    smoothness: number;
    trans: number;
    ior: number;
    emColor: number[];
    emStrength: number;
    map_Kd?: string;
    map_Bump?: string;
}

export interface TriangleData {
    v: number[];
    n: number[];
    t: number[];
    mat?: string;
}

export interface ParsedOBJ {
    groups: Record<string, TriangleData[]>;
    mtllib: string | null;
}

export interface MeshBVHNode {
    min: number[];
    max: number[];
    leftFirst: number;
    triCount: number;
    parent: number;
    pad1?: number; // Right child
}

export interface BVHResult {
    nodes: MeshBVHNode[];
    triangles: any[]; // Depending on structured geometry
    order: Uint32Array;
}
