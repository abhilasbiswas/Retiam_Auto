// @ts-nocheck
import { Math3D, computeWorldAABB } from "../math/math3d";
import { _AnimateWrapper } from "./animations";
import { buildMeshBVH } from "../geometry/bvhBuilder";


export class Material {
    constructor(config = {}) {
        this.color = config.color || [1, 1, 1];
        this.smoothness = config.smoothness !== undefined ? config.smoothness : 0.0;
        this.transparency = config.transparency !== undefined ? config.transparency : 0.0;
        this.ior = config.ior !== undefined ? config.ior : 1.5;
        this.emColor = config.emColor || [0, 0, 0];
        this.emStrength = config.emStrength !== undefined ? config.emStrength : 0.0;
        this.metallic = config.metallic !== undefined ? config.metallic : 0.0;
    }

    clone() {
        return new Material({
            color: [...this.color],
            smoothness: this.smoothness,
            transparency: this.transparency,
            ior: this.ior,
            emColor: [...this.emColor],
            emStrength: this.emStrength,
            metallic: this.metallic
        });
    }

    // --- HELPER PRESETS ---

    static Matte(color = [1, 1, 1]) {
        return new Material({ color, smoothness: 0.0 });
    }

    static Glossy(color = [1, 1, 1], smoothness = 0.8) {
        return new Material({ color, smoothness });
    }

    static Metal(color = [1, 1, 1], smoothness = 0.9) {
        return new Material({ color, smoothness, metallic: 1.0 });
    }

    static Glass(color = [1, 1, 1], ior = 1.5) {
        return new Material({ color, smoothness: 1.0, transparency: 1.0, ior });
    }

    static Emissive(color = [1, 1, 1], strength = 5.0) {
        return new Material({ color: [0, 0, 0], emColor: color, emStrength: strength });
    }

    // This forces IOR to 1.0, which disables refraction so light travels perfectly straight!
    static TransparentNoRefraction(color = [0.4, 0.7, 1.0], transparency = 0.8) {
        return new Material({ color, smoothness: 1.0, transparency: transparency, ior: 1.0, metallic: 0.0, });
    }
}
export class Mobject {
    constructor() {
        this.position = [0, 0, 0];
        this.rotation = [0, 0, 0];
        this.scale = [1, 1, 1];

        // Use the new Material Class
        this.material = new Material();

        this.opacity = 1.0;
        this.value = 0.0;
        this.updaters = [];
        this.parent = null;
        this.children = [];
        this.isInteractable = false;
        this.name = '';
    }

    // Proxies to keep Engine updates and Animation Timelines working seamlessly
    get color() { return this.material.color; }
    set color(v) { this.material.color = v; }
    get smoothness() { return this.material.smoothness; }
    set smoothness(v) { this.material.smoothness = v; }
    get transparency() { return this.material.transparency; }
    set transparency(v) { this.material.transparency = v; }
    get ior() { return this.material.ior; }
    set ior(v) { this.material.ior = v; }
    get emColor() { return this.material.emColor; }
    set emColor(v) { this.material.emColor = v; }
    get emStrength() { return this.material.emStrength; }
    set emStrength(v) { this.material.emStrength = v; }
    get metallic() { return this.material.metallic; }
    set metallic(v) { this.material.metallic = v; }

    set_material(matOrColor, smoothness, trans, ior, emColor, emStrength, metallic) {
        if (matOrColor instanceof Material) {
            this.material = matOrColor.clone();
        } else if (Array.isArray(matOrColor)) {
            // Backward compatibility for legacy arrays
            this.material = new Material({
                color: matOrColor,
                smoothness: smoothness !== undefined ? smoothness : 0.0,
                transparency: trans !== undefined ? trans : 0.0,
                ior: ior !== undefined ? ior : 1.5,
                emColor: emColor || [0, 0, 0],
                emStrength: emStrength !== undefined ? emStrength : 0.0,
                metallic: metallic !== undefined ? metallic : 0.0
            });
        }
        return this;
    }

    add_updater(func) { this.updaters.push(func); return this; }
    remove_updater(func) { this.updaters = this.updaters.filter(u => u !== func); return this; }

    add(...mobs) { mobs.forEach(m => { m.parent = this; this.children.push(m); }); return this; }

    get_world_matrix() {
        let local = Math3D.mat4();
        Math3D.mat4FromTransform(local, this.position, this.rotation, this.scale);
        if (this.parent) {
            let parentWorld = this.parent.get_world_matrix();
            let world = Math3D.mat4();
            Math3D.mat4Multiply(world, parentWorld, local);
            return world;
        }
        return local;
    }

    get_aabb() {
        if (this.localAABB) {
            let mat = this.get_world_matrix();
            return computeWorldAABB([this.localAABB[0], this.localAABB[1], this.localAABB[2]], [this.localAABB[3], this.localAABB[4], this.localAABB[5]], mat);
        }
        let p = this.position; let r = this.radius ? this.radius * this.scale[0] : 0.001;
        return { min: [p[0] - r, p[1] - r, p[2] - r], max: [p[0] + r, p[1] + r, p[2] + r] };
    }

    next_to(other, direction = [1, 0, 0], buff = 0.5) {
        let myAabb = this.get_aabb(); let otherAabb = other.get_aabb();
        let myW = myAabb.max[0] - myAabb.min[0], myH = myAabb.max[1] - myAabb.min[1], myD = myAabb.max[2] - myAabb.min[2];

        let targetX = this.position[0], targetY = this.position[1], targetZ = this.position[2];
        if (direction[0] > 0) targetX = otherAabb.max[0] + myW / 2 + buff; else if (direction[0] < 0) targetX = otherAabb.min[0] - myW / 2 - buff;
        if (direction[1] > 0) targetY = otherAabb.max[1] + myH / 2 + buff; else if (direction[1] < 0) targetY = otherAabb.min[1] - myH / 2 - buff;
        if (direction[2] > 0) targetZ = otherAabb.max[2] + myD / 2 + buff; else if (direction[2] < 0) targetZ = otherAabb.min[2] - myD / 2 - buff;

        this.position = [
            direction[0] !== 0 ? targetX : this.position[0], direction[1] !== 0 ? targetY : this.position[1], direction[2] !== 0 ? targetZ : this.position[2]
        ];
        return this;
    }

    shift(dx, dy, dz) { this.position[0] += dx; this.position[1] += dy; this.position[2] += dz; return this; }
    scale_by(s) { this.scale[0] *= s; this.scale[1] *= s; this.scale[2] *= s; return this; }
    rotate(x, y, z) { this.rotation[0] += x; this.rotation[1] += y; this.rotation[2] += z; return this; }

    copyState() {
        return {
            position: [...this.position], rotation: [...this.rotation], scale: [...this.scale],
            color: [...this.color], smoothness: this.smoothness,
            emColor: [...this.emColor], emStrength: this.emStrength, transparency: this.transparency,
            ior: this.ior, metallic: this.metallic,
            opacity: this.opacity,
            value: this.value
        };
    }

    applyState(state) {
        this.position = [...state.position]; this.rotation = [...state.rotation]; this.scale = [...state.scale];
        this.color = [...state.color]; this.smoothness = state.smoothness;
        this.emColor = [...state.emColor]; this.emStrength = state.emStrength; this.transparency = state.transparency;
        this.ior = state.ior; this.metallic = state.metallic;
        this.opacity = state.opacity;
        this.value = state.value;
    }

    // --- INTERACTIVITY API ---
    make_interactable(enable = true) {
        this.isInteractable = enable;
        return this;
    }

    set_name(n) {
        this.name = n;
        return this;
    }

    onMouseDown(intersectPt, rayDir) {
        // Default behavior: Record intersection offset relative to object center
        this._dragOffset = [
            this.position[0] - intersectPt[0],
            this.position[1] - intersectPt[1],
            this.position[2] - intersectPt[2]
        ];
        return true; // Return true to consume the event and start dragging
    }

    onMouseDrag(newIntersectPt, rayDir, tHit) {
        // Default behavior: 3D translation following mouse along intersection plane
        if (this._dragOffset) {
            this.position = [
                newIntersectPt[0] + this._dragOffset[0],
                newIntersectPt[1] + this._dragOffset[1],
                newIntersectPt[2] + this._dragOffset[2]
            ];
            return true; // Return true to indicate the object moved (triggers accumulation clear)
        }
        return false;
    }

    onMouseUp() {
        this._dragOffset = null;
    }

    animate(kwargs) { return new _AnimateWrapper(this, kwargs); }
}

export class ValueTracker extends Mobject { constructor(val = 0) { super(); this.value = val; } get_value() { return this.value; } }

export class Group extends Mobject {
    constructor(...mobs) {
        super();
        this.add(...mobs);
    }

    set_material(...args) {
        super.set_material(...args);
        this.children.forEach(c => c.set_material(...args));
        return this;
    }

    get opacity() {
        return this._opacity !== undefined ? this._opacity : 1.0;
    }

    set opacity(v) {
        this._opacity = v;
        if (this.children) {
            const applyOpacity = (obj, val) => {
                obj.opacity = val;
                if (obj.children) obj.children.forEach(c => applyOpacity(c, val));
            };
            this.children.forEach(c => applyOpacity(c, v));
        }
    }
}

export class MeshObject extends Mobject {
    constructor(tris, isSmooth = true) {
        super();
        this.triangles = tris;
        this.isSmooth = isSmooth;
    }
}


export class TaichiWater extends MeshObject {
    constructor(N = 45, size = 12.0) {
        let tris = [];
        let dummyUV = [0, 0];
        for (let i = 0; i < N - 1; i++) {
            for (let j = 0; j < N - 1; j++) {
                tris.push([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0], dummyUV, dummyUV, dummyUV]);
                tris.push([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0], dummyUV, dummyUV, dummyUV]);
            }
        }
        super(tris, true);

        this.N = N;
        this.size = size;
        this.isSimulating = false;

        // CRITICAL: Force a large AABB bounding box so moving waves aren't clipped by the Ray Tracer
        this.localAABB = [-size / 2, -5.0, -size / 2, size / 2, 5.0, size / 2];

        this.set_material([0.7, 0.9, 1.0], 0.98, 0.8, 1.33);

        this.add_updater((mob, dt) => {
            if (!mob.initialized || mob.isSimulating) return;
            mob.isSimulating = true;
            mob.runSimulationStep()
                .then(() => { mob.isSimulating = false; })
                .catch(err => { console.error("Sim error:", err); mob.isSimulating = false; });
        });
    }

    async initTaichi(engine) {
        // Intercept WebGPU initialization so Taichi perfectly shares your Engine's device
        const originalRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
        navigator.gpu.requestAdapter = async function (options) {
            return {
                requestDevice: async () => engine.device,
                features: engine.adapter.features,
                limits: engine.adapter.limits,
                isFallbackAdapter: false
            };
        };

        await ti.init();
        navigator.gpu.requestAdapter = originalRequestAdapter;

        let N = this.N;
        this.heights = ti.field(ti.f32, [N * N]);
        this.vels = ti.field(ti.f32, [N * N]);
        this.dropCoords = ti.field(ti.i32, [2]);
        this.dropAmt = ti.field(ti.f32, [1]);

        const heights = this.heights;
        const vels = this.vels;
        const dropCoords = this.dropCoords;
        const dropAmt = this.dropAmt;

        ti.addToKernelScope({ heights, vels, dropCoords, dropAmt, N });

        this.computeForces = ti.kernel(() => {
            for (let I of ti.ndrange(N, N)) {
                let i = I[0];
                let j = I[1];
                if (i > 0 && i < N - 1 && j > 0 && j < N - 1) {
                    let idx = ti.i32(i * N + j);
                    let left = ti.i32((i - 1) * N + j);
                    let right = ti.i32((i + 1) * N + j);
                    let up = ti.i32(i * N + (j - 1));
                    let down = ti.i32(i * N + (j + 1));

                    // AST BUG FIX: ALL FIELDS MUST USE DOUBLE BRACKETS [[ ]]
                    let h_center = heights[[idx]];
                    let force = heights[[left]] + heights[[right]] + heights[[up]] + heights[[down]] - 4.0 * h_center;

                    vels[[idx]] = (vels[[idx]] + force * 0.08) * 0.98;
                }
            }
        });

        this.applyVelocities = ti.kernel(() => {
            for (let I of ti.ndrange(N, N)) {
                let i = I[0];
                let j = I[1];
                let idx = ti.i32(i * N + j);
                heights[[idx]] = heights[[idx]] + vels[[idx]];
            }
        });

        this.dropStone = ti.kernel(() => {
            let x = dropCoords[[0]];
            let y = dropCoords[[1]];
            let idx = ti.i32(x * N + y);
            heights[[idx]] = heights[[idx]] + dropAmt[[0]];
        });

        await this.dropCoords.fromArray([Math.floor(N / 2), Math.floor(N / 2)]);
        await this.dropAmt.fromArray([-5.0]);
        this.dropStone();

        this.initialized = true;
    }

    async runSimulationStep() {
        if (Math.random() < 0.08) {
            let rx = Math.floor(Math.random() * (this.N - 4)) + 2;
            let ry = Math.floor(Math.random() * (this.N - 4)) + 2;
            await this.dropCoords.fromArray([rx, ry]);
            await this.dropAmt.fromArray([-1.5]);
            this.dropStone();
        }

        this.computeForces();
        this.applyVelocities();

        let hArr = await this.heights.toArray();

        // Check the browser console! This should be actively logging the height changing
        let centerHeight = hArr[Math.floor(this.N / 2) * this.N + Math.floor(this.N / 2)];
        // if (Math.abs(centerHeight) > 0.01) console.log("Center Wave Height:", centerHeight.toFixed(3));

        let step = this.size / (this.N - 1);
        let offset = -this.size / 2;
        let getH = (i, j) => hArr[Math.max(0, Math.min(this.N - 1, i)) * this.N + Math.max(0, Math.min(this.N - 1, j))];

        let vNormals = [];
        for (let i = 0; i < this.N; i++) {
            for (let j = 0; j < this.N; j++) {
                let dx = getH(i + 1, j) - getH(i - 1, j);
                let dz = getH(i, j + 1) - getH(i, j - 1);
                vNormals.push(Math3D.normalize([-dx, 2.0 * step, -dz]));
            }
        }

        let tIdx = 0;
        let uv = [0, 0];
        for (let i = 0; i < this.N - 1; i++) {
            for (let j = 0; j < this.N - 1; j++) {
                let i00 = i * this.N + j, i10 = (i + 1) * this.N + j;
                let i01 = i * this.N + (j + 1), i11 = (i + 1) * this.N + (j + 1);

                let p00 = [offset + i * step, hArr[i00], offset + j * step];
                let p10 = [offset + (i + 1) * step, hArr[i10], offset + j * step];
                let p01 = [offset + i * step, hArr[i01], offset + (j + 1) * step];
                let p11 = [offset + (i + 1) * step, hArr[i11], offset + (j + 1) * step];

                this.triangles[tIdx++] = [p00, p10, p01, vNormals[i00], vNormals[i10], vNormals[i01], uv, uv, uv];
                this.triangles[tIdx++] = [p10, p11, p01, vNormals[i10], vNormals[i11], vNormals[i01], uv, uv, uv];
            }
        }

        this.bvhDirty = true;
        if (this.scene && this.scene.engine) {
            this.scene.engine.bakeMeshes(this.scene.mobjects);
            this.scene.frameCount = 0;
        }
    }
}



export class NativeGPUWater extends MeshObject {
    constructor(N = 60, size = 15.0) {
        // 1. Generate flat base grid
        let tris = [];
        let dummyUV = [0, 0];
        let step = size / (N - 1);
        let offset = -size / 2;

        for (let i = 0; i < N - 1; i++) {
            for (let j = 0; j < N - 1; j++) {
                let p00 = [offset + i * step, 0, offset + j * step];
                let p10 = [offset + (i + 1) * step, 0, offset + j * step];
                let p01 = [offset + i * step, 0, offset + (j + 1) * step];
                let p11 = [offset + (i + 1) * step, 0, offset + (j + 1) * step];
                let n = [0, 1, 0];

                tris.push([p00, p10, p01, n, n, n, dummyUV, dummyUV, dummyUV]);
                tris.push([p10, p11, p01, n, n, n, dummyUV, dummyUV, dummyUV]);
            }
        }
        super(tris, true);

        this.N = N;
        this.size = size;

        // HUGE BOUNDING BOX: Prevents the ray tracer from clipping the dynamic waves
        this.localAABB = [-size / 2, -5.0, -size / 2, size / 2, 5.0, size / 2];
        this.set_material([0.7, 0.9, 1.0], 0.98, 0.8, 1.33);

        this.gpuSetupDone = false;

        // Binds directly into the engine's update loop
        this.add_updater((mob, dt) => {
            // Wait until bakeMeshes() assigns the global offsets to this mesh
            if (mob.scene && mob.scene.engine && mob.triOffset !== undefined) {
                if (!mob.gpuSetupDone) mob.initGPU(mob.scene.engine);
                mob.stepSimulation(mob.scene.engine);
            }
        });
    }
    initGPU(engine) {
        this.device = engine.device;

        // 1. Only create simulation buffers once so waves aren't wiped out on BVH switch
        if (!this.bufHeights) {
            this.bufHeights = this.device.createBuffer({ size: this.N * this.N * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
            this.bufVels = this.device.createBuffer({ size: this.N * this.N * 4, usage: GPUBufferUsage.STORAGE });
            this.bufParams = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

            let baseData = engine.serializeTris(this.triangles);
            this.bufBaseTris = this.device.createBuffer({ size: baseData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
            this.device.queue.writeBuffer(this.bufBaseTris, 0, baseData);
        }

        // 2. ALWAYS recreate BVH-dependent buffers because node count changes between SAH/Spatial
        this.leafIndices = [];
        for (let i = 0; i < this.bvh.nodes.length; i++) {
            if (this.bvh.nodes[i].triCount > 0) this.leafIndices.push(i);
        }
        this.bufLeafIndices = this.device.createBuffer({ size: this.leafIndices.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this.device.queue.writeBuffer(this.bufLeafIndices, 0, new Uint32Array(this.leafIndices));

        this.bufFlags = this.device.createBuffer({ size: this.bvh.nodes.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

        // 3. Compile Shaders (Only need to do this once)
        if (!this.module) {
            const wgsl = `
                struct Params { N: u32, triOffset: u32, bvhRootOffset: u32, leafCount: u32, size: f32, dropX: u32, dropY: u32, dropAmt: f32 }
                struct Triangle { v0: vec4<f32>, v1: vec4<f32>, v2: vec4<f32>, n0: vec4<f32>, n1: vec4<f32>, n2: vec4<f32> }
                struct BVHNode { aabbMin: vec3<f32>, leftFirst: u32, aabbMax: vec3<f32>, triCount: u32, parentIdx: i32, isLeaf: u32, pad1: u32, pad2: u32 }

                @group(0) @binding(0) var<uniform> p: Params;
                @group(0) @binding(1) var<storage, read_write> heights: array<f32>;
                @group(0) @binding(2) var<storage, read_write> vels: array<f32>;
                @group(0) @binding(3) var<storage, read> baseTris: array<Triangle>;
                @group(0) @binding(4) var<storage, read_write> globalTris: array<Triangle>;
                @group(0) @binding(5) var<storage, read_write> bvhNodes: array<BVHNode>;
                @group(0) @binding(6) var<storage, read_write> flags: array<atomic<u32>>;
                @group(0) @binding(7) var<storage, read> leafIndices: array<u32>;

                fn getH(x: i32, y: i32) -> f32 {
                    let ix = max(0, min(i32(p.N) - 1, x));
                    let iy = max(0, min(i32(p.N) - 1, y));
                    return heights[u32(ix * i32(p.N) + iy)];
                }
                fn getNorm(x: i32, y: i32) -> vec3<f32> {
                    let dx = getH(x + 1, y) - getH(x - 1, y);
                    let dz = getH(x, y + 1) - getH(x, y - 1);
                    let step = p.size / f32(p.N - 1);
                    return normalize(vec3<f32>(-dx, 2.0 * step, -dz));
                }
                fn applyH(v: vec4<f32>) -> vec4<f32> {
                    let step = p.size / f32(p.N - 1);
                    let offset = -p.size / 2.0;
                    let xi = i32(round((v.x - offset) / step));
                    let yi = i32(round((v.z - offset) / step));
                    return vec4<f32>(v.x, getH(xi, yi), v.z, v.w);
                }
                fn applyN(v: vec4<f32>) -> vec4<f32> {
                    let step = p.size / f32(p.N - 1);
                    let offset = -p.size / 2.0;
                    let xi = i32(round((v.x - offset) / step));
                    let yi = i32(round((v.z - offset) / step));
                    return vec4<f32>(getNorm(xi, yi), 0.0);
                }

                @compute @workgroup_size(8, 8)
                fn simStep(@builtin(global_invocation_id) id: vec3<u32>) {
                    let x = id.x; let y = id.y; let N = p.N;
                    if (x >= N || y >= N) { return; }
                    let idx = x * N + y;
                    if (x == p.dropX && y == p.dropY) { heights[idx] += p.dropAmt; }
                    if (x > 0 && x < N - 1 && y > 0 && y < N - 1) {
                        let left = (x - 1) * N + y; let right = (x + 1) * N + y;
                        let up = x * N + (y - 1); let down = x * N + (y + 1);
                        let force = heights[left] + heights[right] + heights[up] + heights[down] - 4.0 * heights[idx];
                        vels[idx] = (vels[idx] + force * 0.08) * 0.98;
                    }
                }

                @compute @workgroup_size(8, 8)
                fn applyVel(@builtin(global_invocation_id) id: vec3<u32>) {
                    let x = id.x; let y = id.y; let N = p.N;
                    if (x >= N || y >= N) { return; }
                    let idx = x * N + y;
                    heights[idx] += vels[idx];
                }

                @compute @workgroup_size(64)
                fn updateEngineBVH(@builtin(global_invocation_id) id: vec3<u32>) {
                    let leafId = id.x;
                    if (leafId >= p.leafCount) { return; }
                    let localLeafIdx = leafIndices[leafId];
                    let leafIdx = p.bvhRootOffset + localLeafIdx;
                    let triStart = bvhNodes[leafIdx].leftFirst;
                    let triCount = bvhNodes[leafIdx].triCount;
                    var aabbMin = vec3<f32>(999999.0); var aabbMax = vec3<f32>(-999999.0);

                    for (var i = 0u; i < triCount; i++) {
                        let globalTriIdx = triStart + i;
                        let localTriIdx = globalTriIdx - p.triOffset;
                        var tri = baseTris[localTriIdx];
                        tri.v0 = applyH(tri.v0); tri.v1 = applyH(tri.v1); tri.v2 = applyH(tri.v2);
                        tri.n0 = applyN(tri.v0); tri.n1 = applyN(tri.v1); tri.n2 = applyN(tri.v2);
                        globalTris[globalTriIdx] = tri;
                        aabbMin = min(aabbMin, min(tri.v0.xyz, min(tri.v1.xyz, tri.v2.xyz)));
                        aabbMax = max(aabbMax, max(tri.v0.xyz, max(tri.v1.xyz, tri.v2.xyz)));
                    }

                    bvhNodes[leafIdx].aabbMin = aabbMin; bvhNodes[leafIdx].aabbMax = aabbMax;

                    var currNodeIdx = leafIdx;
                    while (true) {
                        let parentIdxF = bvhNodes[currNodeIdx].parentIdx;
                        if (parentIdxF < 0) { break; } 
                        let parentIdx = u32(parentIdxF); 
                        let localParentIdx = parentIdx - p.bvhRootOffset;
                        let old_val = atomicAdd(&flags[localParentIdx], 1u);
                        if (old_val == 0u) { break; } 
                        let leftChild = bvhNodes[parentIdx].leftFirst; 
                        let rightChild = bvhNodes[parentIdx].pad1; 
                        bvhNodes[parentIdx].aabbMin = min(bvhNodes[leftChild].aabbMin, bvhNodes[rightChild].aabbMin);
                        bvhNodes[parentIdx].aabbMax = max(bvhNodes[leftChild].aabbMax, bvhNodes[rightChild].aabbMax);
                        currNodeIdx = parentIdx;
                    }
                }
            `;
            this.module = this.device.createShaderModule({ code: wgsl });

            this.bindGroupLayout = this.device.createBindGroupLayout({
                entries: [
                    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                    { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                    { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }
                ]
            });

            const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });
            this.simPipeline = this.device.createComputePipeline({ layout: pipelineLayout, compute: { module: this.module, entryPoint: 'simStep' } });
            this.velPipeline = this.device.createComputePipeline({ layout: pipelineLayout, compute: { module: this.module, entryPoint: 'applyVel' } });
            this.refitPipeline = this.device.createComputePipeline({ layout: pipelineLayout, compute: { module: this.module, entryPoint: 'updateEngineBVH' } });
        }

        // 4. Update the Bind Group with the fresh buffers (Engine buffers might have resized too!)
        this.bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.bufParams } },
                { binding: 1, resource: { buffer: this.bufHeights } },
                { binding: 2, resource: { buffer: this.bufVels } },
                { binding: 3, resource: { buffer: this.bufBaseTris } },
                { binding: 4, resource: { buffer: engine.triangleArena.gpuBuffer } }, // <--- CHANGED
                { binding: 5, resource: { buffer: engine.bvhArena.gpuBuffer } },      // <--- CHANGED
                { binding: 6, resource: { buffer: this.bufFlags } },
                { binding: 7, resource: { buffer: this.bufLeafIndices } }
            ]
        });

        this.gpuSetupDone = true;
    }

    stepSimulation(engine) {
        let dropX = 9999, dropY = 9999, dropAmt = 0.0;
        if (Math.random() < 0.10) {
            dropX = Math.floor(Math.random() * (this.N - 4)) + 2;
            dropY = Math.floor(Math.random() * (this.N - 4)) + 2;
            dropAmt = -2.0;
        }

        let pData = new Uint32Array(8);
        let pDataF32 = new Float32Array(pData.buffer);
        pData[0] = this.N; pData[1] = this.triOffset; pData[2] = this.bvhRootOffset; pData[3] = this.leafIndices.length;
        pDataF32[4] = this.size; pData[5] = dropX; pData[6] = dropY; pDataF32[7] = dropAmt;

        engine.device.queue.writeBuffer(this.bufParams, 0, pData);
        engine.device.queue.writeBuffer(this.bufFlags, 0, new Uint32Array(this.bvh.nodes.length).fill(0));

        const enc = engine.device.createCommandEncoder();

        // Step 1: Compute Physics
        const pass = enc.beginComputePass();
        pass.setPipeline(this.simPipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.dispatchWorkgroups(Math.ceil(this.N / 8), Math.ceil(this.N / 8));

        // Step 2: Apply Velocities
        pass.setPipeline(this.velPipeline);
        pass.dispatchWorkgroups(Math.ceil(this.N / 8), Math.ceil(this.N / 8));

        // Step 3: Zero-Copy BVH Refit!
        pass.setPipeline(this.refitPipeline);
        pass.dispatchWorkgroups(Math.ceil(this.leafIndices.length / 64));
        pass.end();

        engine.device.queue.submit([enc.finish()]);

        this.scene.frameCount = 0; // Trigger denoiser refresh
    }
}

// ==========================================
// PARAMETRIC SURFACES
// ==========================================
export class ParametricSurface extends MeshObject {
    constructor(func, uRange = [0, 1], vRange = [0, 1], uSeg = 30, vSeg = 30, color = [1, 1, 1]) {
        const verts = [], normals = [], tris = [];
        for (let i = 0; i <= uSeg; i++) {
            let u = uRange[0] + (uRange[1] - uRange[0]) * (i / uSeg);
            for (let j = 0; j <= vSeg; j++) {
                let v = vRange[0] + (vRange[1] - vRange[0]) * (j / vSeg);
                let p = func(u, v);
                verts.push([p.x, p.y, p.z]);

                let pu = func(u + 0.001, v), pv = func(u, v + 0.001);
                let du = [pu.x - p.x, pu.y - p.y, pu.z - p.z], dv = [pv.x - p.x, pv.y - p.y, pv.z - p.z];
                let nx = du[1] * dv[2] - du[2] * dv[1], ny = du[2] * dv[0] - du[0] * dv[2], nz = du[0] * dv[1] - du[1] * dv[0];
                normals.push(Math3D.normalize([nx, ny, nz]));
            }
        }
        for (let i = 0; i < uSeg; i++) {
            for (let j = 0; j < vSeg; j++) {
                let p1 = i * (vSeg + 1) + j, p2 = p1 + 1, p3 = (i + 1) * (vSeg + 1) + j, p4 = p3 + 1;
                tris.push([verts[p1], verts[p2], verts[p3], normals[p1], normals[p2], normals[p3]]);
                tris.push([verts[p2], verts[p4], verts[p3], normals[p2], normals[p4], normals[p3]]);
            }
        }
        super(tris, true);
        this.set_material(color, 0.5);
    }
}

export class RaytracedPath extends MeshObject {
    constructor(svgPathCommands, color = [1, 1, 1], isFill = false) {
        let tris = [];
        let n = [0, 0, 1]; // Assuming flat 2D shapes oriented towards +Z

        // Loop-Blinn Magic UVs
        const uv0 = [0.0, 0.0];
        const uv1 = [0.5, 0.0];
        const uv2 = [1.0, 1.0];

        // 1. Convert path commands to Quadratic Beziers (simplified for example)
        let quadratics = this.parsePathToQuadratics(svgPathCommands);

        for (let q of quadratics) {
            let p0 = [q[0].x, q[0].y, 0];
            let p1 = [q[1].x, q[1].y, 0];
            let p2 = [q[2].x, q[2].y, 0];

            // 2. Add the bounding triangle for the curve
            tris.push([p0, p1, p2, n, n, n, uv0, uv1, uv2]);
        }

        super(tris, false);
        this.isImplicit = true; // Triggers vectorType == 3 in WGSL
        this.isSmooth = isFill; // We hijack isSmooth (mesh.mat2.w) to toggle Fill/Stroke

        // Material properties
        this.set_material(color, 0.0, 0.0, 1.5, color, 1.0);
    }

    // Mathematical utility to convert Cubic Beziers to Quadratics
    parsePathToQuadratics(commands) {
        let quads = [];
        // Implementation: Iterate through SVG path. 
        // If you encounter a Cubic Bezier (C), split it into two Quadratics:
        // Midpoint subdivision ensures visual accuracy.
        for (let seg of commands) {
            if (seg.type === 'C') {
                const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
                const p01 = lerp(seg.p0, seg.p1, 0.5);
                const p12 = lerp(seg.p1, seg.p2, 0.5);
                const p23 = lerp(seg.p2, seg.p3, 0.5);
                const p012 = lerp(p01, p12, 0.5);
                const p123 = lerp(p12, p23, 0.5);
                const p0123 = lerp(p012, p123, 0.5);

                // First half quadratic approximation
                quads.push([
                    seg.p0,
                    { x: 0.75 * p01.x + 0.75 * p012.x - 0.5 * seg.p0.x, y: 0.75 * p01.y + 0.75 * p012.y - 0.5 * seg.p0.y },
                    p0123
                ]);

                // Second half quadratic approximation
                quads.push([
                    p0123,
                    { x: 0.75 * p123.x + 0.75 * p23.x - 0.5 * seg.p3.x, y: 0.75 * p123.y + 0.75 * p23.y - 0.5 * seg.p3.y },
                    seg.p3
                ]);
            } else if (seg.type === 'Q') {
                quads.push([seg.p0, seg.p1, seg.p2]);
            }
        }
        return quads;
    }
}
// ==========================================
// DYNAMIC VECTOR & TEXT ATLAS SYSTEM (RASTER)
// ==========================================
export class VectorAtlas {
    constructor(width = 2048, height = 2048) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = width; this.canvas.height = height;
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        this.ctx.clearRect(0, 0, width, height);
        this.currentX = 0; this.currentY = 0; this.maxRowHeight = 0;
        this.textureReady = false;
    }

    clear() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.currentX = 0; this.currentY = 0; this.maxRowHeight = 0;
        this.textureReady = true;
    }

    addGraphic(width, height, drawCallback) {
        if (this.currentX + width > this.canvas.width) {
            this.currentX = 0; this.currentY += this.maxRowHeight + 2; this.maxRowHeight = 0;
        }
        if (this.currentY + height > this.canvas.height) { console.error("Vector Atlas full!"); return { uv: [0, 0, 1, 1], x: 0, y: 0 }; }

        let x = this.currentX; let y = this.currentY;
        this.ctx.save(); this.ctx.translate(x, y);
        drawCallback(this.ctx); this.ctx.restore();

        let uMin = x / this.canvas.width; let vMin = y / this.canvas.height;
        let uMax = (x + width) / this.canvas.width; let vMax = (y + height) / this.canvas.height;

        this.currentX += width + 2; this.maxRowHeight = Math.max(this.maxRowHeight, height);
        this.textureReady = true;
        return { uv: [uMin, vMin, uMax, vMax], x, y };
    }
}
export const globalVectorAtlas = new VectorAtlas();

export class VectorObject extends MeshObject {
    constructor(width, height, drawCallback) {
        let slot = globalVectorAtlas.addGraphic(width, height, drawCallback);
        let w = 1.0; let h = height / width;
        let v0 = [-w, -h, 0], v1 = [w, -h, 0], v2 = [-w, h, 0], v3 = [w, h, 0]; let n = [0, 0, 1];
        let uv0 = [slot.uv[0], slot.uv[3]], uv1 = [slot.uv[2], slot.uv[3]];
        let uv2 = [slot.uv[0], slot.uv[1]], uv3 = [slot.uv[2], slot.uv[1]];

        let tris = [[v0, v1, v2, n, n, n, uv0, uv1, uv2], [v1, v3, v2, n, n, n, uv1, uv3, uv2]];
        super(tris, false);
        this.isVector = true; this.atlasSlot = slot; this.width = width; this.height = height;
        this.set_material([1, 1, 1], 0.0);
    }
    async load() { return Promise.resolve(); }
}

export class TextObject extends VectorObject {
    constructor(text, font = "bold 80px sans-serif", color = "white") {
        const ctx = globalVectorAtlas.ctx; ctx.font = font;
        let width = Math.max(1, Math.ceil(ctx.measureText(text).width) + 20);
        let height = 120; let match = font.match(/(\d+)px/); if (match) height = parseInt(match[1]) * 1.5 + 20;

        super(width, height, (c) => {
            c.font = font; c.fillStyle = color; c.textBaseline = "middle"; c.textAlign = "center";
            c.fillText(text, width / 2, height / 2);
        });

        this.text = text; this.font = font; this.fontColor = color;
    }

    setReveal(alpha) {
        const ctx = globalVectorAtlas.ctx; ctx.save(); ctx.translate(this.atlasSlot.x, this.atlasSlot.y); ctx.clearRect(0, 0, this.width, this.height);
        ctx.font = this.font; ctx.textBaseline = "middle"; ctx.textAlign = "left";
        const chars = this.text.split(''); const totalChars = chars.length; const stagger = 0.6;
        const fullWidth = ctx.measureText(this.text).width; let startX = (this.width - fullWidth) / 2; const y = this.height / 2;

        for (let i = 0; i < totalChars; i++) {
            const char = chars[i]; const charWidth = ctx.measureText(char).width;
            if (char !== ' ') {
                const charStart = (i / totalChars) * stagger, charEnd = charStart + (1.0 - stagger);
                const cAlpha = Math.max(0, Math.min(1, (alpha - charStart) / (charEnd - charStart)));
                if (cAlpha > 0) {
                    const strokeAlpha = Math.min(1.0, cAlpha / 0.7), fillAlpha = Math.max(0.0, (cAlpha - 0.5) / 0.5);
                    let match = this.font.match(/(\d+)px/); let fSize = match ? parseInt(match[1]) : 80;
                    const dashLen = fSize * 5;
                    ctx.setLineDash([dashLen]); ctx.lineDashOffset = dashLen * (1.0 - strokeAlpha);
                    ctx.lineWidth = Math.max(1, fSize * 0.04); ctx.strokeStyle = this.fontColor; ctx.strokeText(char, startX, y);
                    if (fillAlpha > 0) { ctx.globalAlpha = fillAlpha; ctx.fillStyle = this.fontColor; ctx.fillText(char, startX, y); ctx.globalAlpha = 1.0; }
                }
            }
            startX += charWidth;
        }
        ctx.restore(); globalVectorAtlas.textureReady = true;
    }
}

export class SVGObject extends VectorObject {
    constructor(svgString, width = 512, height = 512) {
        super(width, height, (c) => { });
        let blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }); this.url = URL.createObjectURL(blob);
    }
    async load() {
        return new Promise((resolve) => {
            let img = new Image();
            img.onload = () => {
                globalVectorAtlas.ctx.save(); globalVectorAtlas.ctx.translate(this.atlasSlot.x, this.atlasSlot.y);
                globalVectorAtlas.ctx.drawImage(img, 0, 0, this.width, this.height); globalVectorAtlas.ctx.restore();
                globalVectorAtlas.textureReady = true; resolve();
            };
            img.src = this.url;
        });
    }
}

export class MathTex extends SVGObject {
    constructor(latex, scale = 2.0, color = "white") {
        super("", 1024, 256);
        this.latex = latex; this.texScale = scale; this.texColor = color;
    }
    async load() {
        if (!window.MathJax) {
            await new Promise(r => {
                let s = document.createElement('script');
                s.src = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js";
                s.id = "MathJax-script";
                s.onload = r; document.head.appendChild(s);
            });
        }
        let node = await MathJax.tex2svgPromise(this.latex, { display: true });
        let svgElement = node.querySelector('svg');

        let vb = svgElement.getAttribute("viewBox").split(" ");
        let w = parseFloat(vb[2]), h = parseFloat(vb[3]);
        svgElement.setAttribute("width", "1024px");
        svgElement.setAttribute("height", "256px");

        let svgStr = svgElement.outerHTML.replace(/currentColor/g, this.texColor);
        let blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
        this.url = URL.createObjectURL(blob);

        await super.load();
        this.scale_by(this.texScale);
    }
}

export class ImageObject extends VectorObject {
    constructor(url, width = 512, height = 512) {
        super(width, height, (c) => { });
        this.url = url;
    }
    async load() {
        return new Promise((resolve) => {
            let img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
                globalVectorAtlas.ctx.save();
                globalVectorAtlas.ctx.translate(this.atlasSlot.x, this.atlasSlot.y);
                globalVectorAtlas.ctx.drawImage(img, 0, 0, this.width, this.height);
                globalVectorAtlas.ctx.restore();
                globalVectorAtlas.textureReady = true;
                resolve();
            };
            img.onerror = () => {
                console.warn("Failed to load image: ", this.url);
                resolve();
            };
            img.src = this.url;
        });
    }
}

export class VideoObject extends VectorObject {
    constructor(url, width = 512, height = 512) {
        super(width, height, (c) => { });
        this.url = url;
        this.video = document.createElement('video');
        this.video.crossOrigin = "anonymous";
        this.video.loop = true;
        this.video.muted = true;
        this.video.playsInline = true;

        this.add_updater((mob, dt) => {
            if (mob.video.readyState >= 2 && (window.isRenderingVideo || !mob.video.paused)) {
                globalVectorAtlas.ctx.save();
                globalVectorAtlas.ctx.translate(mob.atlasSlot.x, mob.atlasSlot.y);
                globalVectorAtlas.ctx.drawImage(mob.video, 0, 0, mob.width, mob.height);
                globalVectorAtlas.ctx.restore();
                globalVectorAtlas.textureReady = true;
            }
        });
    }

    async seekTo(time) {
        return new Promise(resolve => {
            if (!this.video.duration || this.video.readyState < 2) { resolve(); return; }
            let targetTime = time % this.video.duration;
            if (Math.abs(this.video.currentTime - targetTime) < 0.01) { resolve(); return; }

            let timeout = setTimeout(() => {
                this.video.removeEventListener('seeked', onSeeked);
                resolve();
            }, 250);

            const onSeeked = () => {
                clearTimeout(timeout);
                this.video.removeEventListener('seeked', onSeeked);
                resolve();
            };
            this.video.addEventListener('seeked', onSeeked);
            this.video.currentTime = targetTime;
        });
    }

    async load() {
        return new Promise((resolve) => {
            this.video.addEventListener('canplay', () => {
                if (!window.isRenderingVideo) {
                    this.video.play().catch(e => console.warn("Video autoplay prevented:", e));
                }
                resolve();
            }, { once: true });
            this.video.addEventListener('error', () => {
                console.warn("Failed to load video:", this.url);
                resolve();
            }, { once: true });
            this.video.src = this.url;
            this.video.load();
        });
    }
}

// ==========================================
// NATIVE MSDF DISTANCE FIELD EVALUATION
// ==========================================
export class MSDFObject extends MeshObject {
    constructor(width = 2, height = 2, color = [1, 0.8, 0.2]) {
        let w = width / 2, h = height / 2;
        let v0 = [-w, -h, 0], v1 = [w, -h, 0], v2 = [-w, h, 0], v3 = [w, h, 0], n = [0, 0, 1];
        let tris = [[v0, v1, v2, n, n, n, [0, 1], [1, 1], [0, 0]], [v1, v3, v2, n, n, n, [1, 1], [1, 0], [0, 0]]];
        super(tris, false);
        this.isMSDF = true;
        this.set_material(color, 0.1, 0.0, 1.5, color, 1.0);
    }
}

// ==========================================
// IMPLICIT CURVE LOOP-BLINN EVALUATION
// ==========================================
function cubicToQuadratics(p0, p1, p2, p3) {
    const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const p01 = lerp(p0, p1, 0.5), p12 = lerp(p1, p2, 0.5), p23 = lerp(p2, p3, 0.5);
    const p012 = lerp(p01, p12, 0.5), p123 = lerp(p12, p23, 0.5), p0123 = lerp(p012, p123, 0.5);
    const q1 = [p0, { x: 0.75 * (p01.x + p012.x) - 0.25 * (p0.x + p0123.x), y: 0.75 * (p01.y + p012.y) - 0.25 * (p0.y + p0123.y) }, p0123];
    const q2 = [p0123, { x: 0.75 * (p123.x + p23.x) - 0.25 * (p0123.x + p3.x), y: 0.75 * (p123.y + p23.y) - 0.25 * (p0123.y + p3.y) }, p3];
    return [q1, q2];
}

export class ImplicitCurveObject extends MeshObject {
    constructor(pathSegments, color = [1, 0.2, 0.8]) {
        let tris = []; let center = { x: 0, y: 0 }; let count = 0; let quadratics = [];
        for (let seg of pathSegments) {
            let quads = cubicToQuadratics(seg.p0, seg.p1, seg.p2, seg.p3);
            quadratics.push(...quads);
            center.x += seg.p0.x; center.y += seg.p0.y; count++;
        }
        center.x /= count; center.y /= count;

        let n = [0, 0, 1]; let solidUV = [0.5, 1.0];
        for (let q of quadratics) {
            let v0 = [q[0].x, q[0].y, 0], v1 = [q[1].x, q[1].y, 0], v2 = [q[2].x, q[2].y, 0], vc = [center.x, center.y, 0];
            tris.push([vc, v0, v2, n, n, n, solidUV, solidUV, solidUV]);
            tris.push([v0, v1, v2, n, n, n, [0.0, 0.0], [0.5, 0.0], [1.0, 1.0]]);
        }
        super(tris, false);
        this.isImplicit = true;
        this.set_material(color, 0.2, 0.0, 1.5, color, 1.0);
    }
}

export class Sphere extends Mobject { constructor(radius = 1.0) { super(); this.radius = radius; } }
export class MorphMeshObject extends Mobject {
    constructor(trisA, trisB, bvhMethod = 'spatial') {
        super();
        this.isMorphing = true;
        this.morphWeight = 0.0;
        this.isSmooth = true;

        // Save the original raw triangles so we can safely rebuild them later
        this.originalTrisA = trisA;
        this.originalTrisB = trisB;

        this.buildMorphBVH(bvhMethod);
    }

    // Custom BVH Builder that perfectly syncs State A and State B
    buildMorphBVH(method) {
        const N = Math.min(this.originalTrisA.length, this.originalTrisB.length);
        let midTris = [];

        // 1. Build a midpoint mesh to generate a safe bounding volume
        for (let i = 0; i < N; i++) {
            let a = this.originalTrisA[i], b = this.originalTrisB[i], mid = [];
            for (let v = 0; v < 6; v++) {
                mid.push([(a[v][0] + b[v][0]) / 2, (a[v][1] + b[v][1]) / 2, (a[v][2] + b[v][2]) / 2]);
            }
            midTris.push(mid);
        }

        // 2. Generate the BVH (Using Spatial or SAH)
        let bvhData = buildMeshBVH(midTris, method);

        // 3. Re-sort BOTH State A and State B using the new BVH order
        this.activeTrisA = [];
        this.activeTrisB = [];
        for (let i = 0; i < N; i++) {
            this.activeTrisA.push(this.originalTrisA[bvhData.order[i]]);
            this.activeTrisB.push(this.originalTrisB[bvhData.order[i]]);
        }

        // 4. Calculate maximum physical bounds of both states
        let aabbMin = [99999, 99999, 99999], aabbMax = [-99999, -99999, -99999];
        for (let i = 0; i < N; i++) {
            for (let v = 0; v < 3; v++) {
                for (let a = 0; a < 3; a++) {
                    aabbMin[a] = Math.min(aabbMin[a], this.activeTrisA[i][v][a], this.activeTrisB[i][v][a]);
                    aabbMax[a] = Math.max(aabbMax[a], this.activeTrisA[i][v][a], this.activeTrisB[i][v][a]);
                }
            }
        }

        this.localAABB = [...aabbMin, ...aabbMax];
        this.triangles = this.activeTrisA;
        this.bvh = { nodes: bvhData.nodes, triangles: this.activeTrisA };

        // 5. Update the leaf indices for the compute shader
        this.leafIndices = [];
        for (let i = 0; i < this.bvh.nodes.length; i++) {
            if (this.bvh.nodes[i].triCount > 0) this.leafIndices.push(i);
        }

        // 6. Force the engine to recreate the WebGPU buffers on the next frame
        this.gpuSetupDone = false;
    }

    setMorph(t) { this.morphWeight = Math.max(0, Math.min(1, t)); }
}
// ==========================================
// Main Scene Architecture
// ==========================================