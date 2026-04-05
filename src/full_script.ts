
            


            
            class OIDNManager {
    constructor(engine) {
        this.engine = engine;
        this.unet = null;
        this.isProcessing = false;
        this.isInitialized = false;
        this.currentModel = null;
        this.initPromise = null;
        
        // Track what buffers the current model requires
        this.useAlbedo = false;
        this.useNormal = false;
    }

    async init(modelFilename) {
        if (this.currentModel === modelFilename && this.initPromise) return this.initPromise;
        this.isInitialized = false;
        this.currentModel = modelFilename;
        
        // Dynamically determine required buffers from the filename!
        // (This matches 'alb', 'calb', 'nrm', 'cnrm' perfectly)
        this.useAlbedo = modelFilename.includes('alb');
        this.useNormal = modelFilename.includes('nrm');
        const requiresAux = this.useAlbedo || this.useNormal;

        console.log(requiresAux)
        this.initPromise = (async () => {
            document.getElementById('status').innerText = `Status: Loading OIDN (${modelFilename})...`;
            document.getElementById('status').style.color = "#00bcd4";
            try {
                const oidn = await import('https://localhost:5173/lib/oidn.js');
                let adapterInfo = typeof this.engine.adapter.requestAdapterInfo === 'function' 
                    ? await this.engine.adapter.requestAdapterInfo() 
                    : this.engine.adapter.info;
                
                const weightUrl = `https://localhost:5173/oidn/${modelFilename}.tza`;

                this.unet = await oidn.initUNetFromURL(weightUrl, { device: this.engine.device, adapterInfo }, { aux: requiresAux, hdr: true });
                this.isInitialized = true;
                console.log(`OIDN Initialized! [Model: ${modelFilename} | Albedo: ${this.useAlbedo} | Normal: ${this.useNormal}]`);
            } catch (err) {
                console.error("Failed to initialize OIDN:", err);
                document.getElementById('status').innerText = `Status: OIDN Init Failed (${modelFilename} missing?)`;
                document.getElementById('status').style.color = "#f44336";
            }
        })();
        return this.initPromise;
    }

    async denoise(frameCount) {
        if (!this.isInitialized || this.isProcessing) return false;
        this.isProcessing = true;

        // Extracts all 3 buffers via your Compute Shader
        const buffers = await this.engine.extractOIDN(frameCount);

        return new Promise((resolve) => {
            let executeParams = {
                color: { data: buffers.color, width: this.engine.width, height: this.engine.height },
                done: (result) => {
                    this.engine.injectOIDN(result.data);
                    this.isProcessing = false;
                    resolve(true);
                }
            };

            // Inject the extra buffers into OIDN only if the loaded weights require them
            if (this.useAlbedo) {
                executeParams.albedo = { data: buffers.albedo, width: this.engine.width, height: this.engine.height };
            }
            if (this.useNormal) {
                executeParams.normal = { data: buffers.normal, width: this.engine.width, height: this.engine.height };
            }

            this.unet.tileExecute(executeParams);
        });
    }
}




            // ==========================================
            // Hardware-Aware GPU Arena Allocator
            // ==========================================
            class GPUArena {
                constructor(device, label, initialCapacity, bytesPerElement, usage) {
                    this.device = device;
                    this.label = label;
                    this.bytesPerElement = bytesPerElement;
                    this.usage = usage;

                    // 1. Query the absolute hardware limit for this specific user's GPU
                    this.maxBytesAllowed = this.device.limits.maxStorageBufferBindingSize;
                    this.maxCapacity = Math.floor(this.maxBytesAllowed / this.bytesPerElement);

                    // 2. Start with a modest size, capped by the hardware limit
                    this.capacity = Math.min(initialCapacity, this.maxCapacity);

                    this._allocateCPU();
                    this._allocateGPU();
                }

                _allocateCPU(oldU8Array = null) {
                    this.cpuBuffer = new ArrayBuffer(this.capacity * this.bytesPerElement);

                    this.f32 = new Float32Array(this.cpuBuffer);
                    this.i32 = new Int32Array(this.cpuBuffer);
                    this.u32 = new Uint32Array(this.cpuBuffer);
                    this.u8 = new Uint8Array(this.cpuBuffer);

                    if (oldU8Array) {
                        this.u8.set(oldU8Array);
                    }
                }

                _allocateGPU() {
                    if (this.gpuBuffer) this.gpuBuffer.destroy();
                    this.gpuBuffer = this.device.createBuffer({
                        label: this.label,
                        size: this.capacity * this.bytesPerElement,
                        usage: this.usage
                    });
                }

                ensureCapacity(requiredElements) {
                    // If we have enough space, do nothing. (Fastest path, 0 cost)
                    if (requiredElements <= this.capacity) return false;

                    // 3. Graceful Hardware Limit checking
                    if (requiredElements > this.maxCapacity) {
                        console.error(`[Arena] FATAL: ${this.label} requires ${requiredElements} elements, but the hardware limit is ${this.maxCapacity}.`);
                        alert(`Your scene is too complex for this device's GPU limits. Reducing geometry is required.`);
                        return false; // Prevent WebGPU crash
                    }

                    const oldCapacity = this.capacity;

                    // 4. Grow by 1.5x, but NEVER exceed the physical GPU limit
                    this.capacity = Math.min(Math.ceil(requiredElements * 1.5), this.maxCapacity);
                    console.log(`[Arena] Expanding ${this.label}: ${oldCapacity} -> ${this.capacity} elements`);

                    const oldU8 = this.u8;
                    this._allocateCPU(oldU8);
                    this._allocateGPU();

                    return true; // Triggers BindGroup rebuilds in the engine
                }

                upload(queue, activeElements) {
                    if (activeElements === 0) return;
                    const activeBytes = activeElements * this.bytesPerElement;
                    queue.writeBuffer(this.gpuBuffer, 0, this.u8.subarray(0, activeBytes));
                }
            }

            // ==========================================
            // Editor Helper Functions (Outliner & Gimbal)
            // ==========================================
            function populateSceneGraph(mobjects) {
                const container = document.getElementById('scene-graph');
                if (!container) return;
                container.innerHTML = '';
                let idCounter = 1;
                const addNode = (obj, parentDiv, depth) => {
                    let name = obj.isMorphing ? "Morph Target" : (obj.triangles ? "Polygonal Mesh" : (obj.radius ? "Analytic Sphere" : "Group"));
                    const el = document.createElement('div'); el.className = 'hierarchy-item'; el.style.paddingLeft = (depth * 15 + 8) + 'px';
                    let icon = '⬡'; if (obj.radius) icon = '⭕'; else if (obj.isVector) icon = '📝'; else if (obj.isMorphing) icon = '💧';
                    el.innerHTML = `<span class="hierarchy-icon">${icon}</span> ${name} ${idCounter++}`; parentDiv.appendChild(el);
                    if (obj.children && obj.children.length > 0) { obj.children.forEach(c => addNode(c, parentDiv, depth + 1)); }
                };
                mobjects.forEach(m => addNode(m, container, 0));
            }

            function drawGimbal(camera) {
                const canvas = document.getElementById('gimbalCanvas');
                if (!canvas) return;
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                const cx = canvas.width / 2; const cy = canvas.height / 2; const radius = 25;
                const project = (wx, wy, wz) => {
                    const x = wx * camera.right[0] + wy * camera.right[1] + wz * camera.right[2];
                    const y = -(wx * camera.up[0] + wy * camera.up[1] + wz * camera.up[2]);
                    const z = wx * camera.dir[0] + wy * camera.dir[1] + wz * camera.dir[2];
                    return { x: cx + x * radius, y: cy + y * radius, z };
                };
                const axes = [{ name: 'X', color: '#ff5252', p: project(1, 0, 0) }, { name: 'Y', color: '#4caf50', p: project(0, 1, 0) }, { name: 'Z', color: '#448aff', p: project(0, 0, 1) }];
                axes.sort((a, b) => a.p.z - b.p.z);
                ctx.lineWidth = 2.5; ctx.lineCap = "round";
                axes.forEach(axis => {
                    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(axis.p.x, axis.p.y); ctx.strokeStyle = axis.color; ctx.stroke();
                    ctx.fillStyle = '#fff'; ctx.font = "bold 10px monospace"; ctx.fillText(axis.name, axis.p.x + (axis.p.x > cx ? 4 : -10), axis.p.y + (axis.p.y > cy ? 10 : -4));
                });
                ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
            }

            // ==========================================
            // Minimal Math Library
            // ==========================================
            const Math3D = {
                vec3: (x = 0, y = 0, z = 0) => new Float32Array([x, y, z]),
                add: (a, b) => Math3D.vec3(a[0] + b[0], a[1] + b[1], a[2] + b[2]),
                sub: (a, b) => Math3D.vec3(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
                scale: (a, s) => Math3D.vec3(a[0] * s, a[1] * s, a[2] * s),
                cross: (a, b) => Math3D.vec3(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]),
                length: (a) => Math.hypot(a[0], a[1], a[2]),
                normalize: (a) => { let len = Math3D.length(a); return len > 0 ? Math3D.vec3(a[0] / len, a[1] / len, a[2] / len) : Math3D.vec3(0, 0, 0); },
                mat4: () => new Float32Array(16),
                mat4Identity: (out) => { out.fill(0); out[0] = out[5] = out[10] = out[15] = 1; return out; },
                mat4Multiply: (out, a, b) => {
                    let a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7], a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
                    let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
                    out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30; out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31; out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32; out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
                    b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
                    out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30; out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31; out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32; out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
                    b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
                    out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30; out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31; out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32; out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
                    b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
                    out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30; out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31; out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32; out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
                    return out;
                },
                mat4FromTransform: (out, pos, rot, scale) => {
                    Math3D.mat4Identity(out); out[12] = pos[0]; out[13] = pos[1]; out[14] = pos[2];
                    let temp = Math3D.mat4(), s = Math.sin(rot[2]), c = Math.cos(rot[2]); Math3D.mat4Identity(temp);
                    temp[0] = c; temp[1] = s; temp[4] = -s; temp[5] = c; Math3D.mat4Multiply(out, out, temp);
                    s = Math.sin(rot[1]); c = Math.cos(rot[1]); Math3D.mat4Identity(temp);
                    temp[0] = c; temp[2] = -s; temp[8] = s; temp[10] = c; Math3D.mat4Multiply(out, out, temp);
                    s = Math.sin(rot[0]); c = Math.cos(rot[0]); Math3D.mat4Identity(temp);
                    temp[5] = c; temp[6] = s; temp[9] = -s; temp[10] = c; Math3D.mat4Multiply(out, out, temp);
                    out[0] *= scale[0]; out[1] *= scale[0]; out[2] *= scale[0];
                    out[4] *= scale[1]; out[5] *= scale[1]; out[6] *= scale[1];
                    out[8] *= scale[2]; out[9] *= scale[2]; out[10] *= scale[2];
                    return out;
                },
                mat4Invert: (out, a) => {
                    let a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
                        a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
                    let b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11,
                        b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30,
                        b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
                    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
                    if (!det) return null; det = 1.0 / det;
                    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det; out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
                    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det; out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
                    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det; out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
                    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det; out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
                    return out;
                },


                // Add inside the Math3D object:
                quat: (x = 0, y = 0, z = 0, w = 1) => new Float32Array([x, y, z, w]),
                quatFromEuler: (euler) => {
                    let cx = Math.cos(euler[0] / 2), sx = Math.sin(euler[0] / 2);
                    let cy = Math.cos(euler[1] / 2), sy = Math.sin(euler[1] / 2);
                    let cz = Math.cos(euler[2] / 2), sz = Math.sin(euler[2] / 2);
                    return Math3D.quat(
                        sx * cy * cz - cx * sy * sz,
                        cx * sy * cz + sx * cy * sz,
                        cx * cy * sz - sx * sy * cz,
                        cx * cy * cz + sx * sy * sz
                    );
                },
                quatSlerp: (a, b, t) => {
                    let out = Math3D.quat();
                    let cosHalfTheta = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
                    if (cosHalfTheta < 0) {
                        b = [-b[0], -b[1], -b[2], -b[3]];
                        cosHalfTheta = -cosHalfTheta;
                    }
                    if (Math.abs(cosHalfTheta) >= 1.0) return a;
                    let halfTheta = Math.acos(cosHalfTheta);
                    let sinHalfTheta = Math.sqrt(1.0 - cosHalfTheta * cosHalfTheta);
                    if (Math.abs(sinHalfTheta) < 0.001) {
                        return Math3D.quat(a[0] * 0.5 + b[0] * 0.5, a[1] * 0.5 + b[1] * 0.5, a[2] * 0.5 + b[2] * 0.5, a[3] * 0.5 + b[3] * 0.5);
                    }
                    let ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
                    let ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
                    out[0] = (a[0] * ratioA) + (b[0] * ratioB);
                    out[1] = (a[1] * ratioA) + (b[1] * ratioB);
                    out[2] = (a[2] * ratioA) + (b[2] * ratioB);
                    out[3] = (a[3] * ratioA) + (b[3] * ratioB);
                    return out;
                },
                eulerFromQuat: (q) => {
                    let ysqr = q[1] * q[1];
                    let t0 = +2.0 * (q[3] * q[0] + q[1] * q[2]);
                    let t1 = +1.0 - 2.0 * (q[0] * q[0] + ysqr);
                    let pitch = Math.atan2(t0, t1);
                    let t2 = +2.0 * (q[3] * q[1] - q[2] * q[0]);
                    t2 = t2 > 1.0 ? 1.0 : t2; t2 = t2 < -1.0 ? -1.0 : t2;
                    let yaw = Math.asin(t2);
                    let t3 = +2.0 * (q[3] * q[2] + q[0] * q[1]);
                    let t4 = +1.0 - 2.0 * (ysqr + q[2] * q[2]);
                    let roll = Math.atan2(t3, t4);
                    return Math3D.vec3(pitch, yaw, roll);
                }

            };

            function computeWorldAABB(localMin, localMax, matrix) {
                const corners = [[localMin[0], localMin[1], localMin[2]], [localMax[0], localMin[1], localMin[2]], [localMin[0], localMax[1], localMin[2]], [localMax[0], localMax[1], localMin[2]], [localMin[0], localMin[1], localMax[2]], [localMax[0], localMin[1], localMax[2]], [localMin[0], localMax[1], localMax[2]], [localMax[0], localMax[1], localMax[2]]];
                let wMin = [99999, 99999, 99999], wMax = [-99999, -99999, -99999];
                for (let c of corners) {
                    let x = c[0] * matrix[0] + c[1] * matrix[4] + c[2] * matrix[8] + matrix[12];
                    let y = c[0] * matrix[1] + c[1] * matrix[5] + c[2] * matrix[9] + matrix[13];
                    let z = c[0] * matrix[2] + c[1] * matrix[6] + c[2] * matrix[10] + matrix[14];
                    wMin[0] = Math.min(wMin[0], x); wMin[1] = Math.min(wMin[1], y); wMin[2] = Math.min(wMin[2], z);
                    wMax[0] = Math.max(wMax[0], x); wMax[1] = Math.max(wMax[1], y); wMax[2] = Math.max(wMax[2], z);
                }
                return { min: wMin, max: wMax };
            }

            // ==========================================
            // JS Geometry Prep & BVH Generation (Fallback)
            // ==========================================
            function buildMeshBVH(meshTriangles, method = 'spatial') {
                let N = meshTriangles.length;
                if (N === 0) return { nodes: [{ min: [0, 0, 0], max: [0, 0, 0], leftFirst: 0, triCount: 0, parent: -1 }], triangles: [], order: new Uint32Array(0) };

                let bvhNodes = [];
                let triIndices = new Uint32Array(N);
                let centroids = new Float32Array(N * 3);

                for (let i = 0; i < N; i++) {
                    triIndices[i] = i;
                    let t = meshTriangles[i];
                    centroids[i * 3 + 0] = (t[0][0] + t[1][0] + t[2][0]) / 3;
                    centroids[i * 3 + 1] = (t[0][1] + t[1][1] + t[2][1]) / 3;
                    centroids[i * 3 + 2] = (t[0][2] + t[1][2] + t[2][2]) / 3;
                }

                let nodesUsed = 1;
                bvhNodes.push({ min: [0, 0, 0], max: [0, 0, 0], leftFirst: 0, triCount: N, parent: -1 });

                function updateNodeBounds(nodeIdx) {
                    let node = bvhNodes[nodeIdx];
                    let min = [99999, 99999, 99999], max = [-99999, -99999, -99999];
                    for (let i = 0; i < node.triCount; i++) {
                        let leafTriIdx = triIndices[node.leftFirst + i];
                        let tri = meshTriangles[leafTriIdx];
                        for (let v = 0; v < 3; v++) {
                            for (let axis = 0; axis < 3; axis++) {
                                min[axis] = Math.min(min[axis], tri[v][axis]);
                                max[axis] = Math.max(max[axis], tri[v][axis]);
                            }
                        }
                    }
                    node.min = min; node.max = max;
                }

                function getSurfaceArea(min, max) {
                    let ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
                    return 2.0 * (ext[0] * ext[1] + ext[1] * ext[2] + ext[2] * ext[0]);
                }

                function subdivide(nodeIdx) {
                    let node = bvhNodes[nodeIdx];
                    if (node.triCount <= 2) return;

                    let axis = 0;
                    let splitPos = 0;
                    let useSpatialFallback = (method === 'spatial');

                    if (method === 'sah') {
                        const BINS = 8;
                        let bestCost = Infinity;

                        // Find bounds of centroids to perfectly fit the bins
                        let cMin = [Infinity, Infinity, Infinity], cMax = [-Infinity, -Infinity, -Infinity];
                        for (let i = 0; i < node.triCount; i++) {
                            let cIdx = triIndices[node.leftFirst + i] * 3;
                            for (let a = 0; a < 3; a++) {
                                cMin[a] = Math.min(cMin[a], centroids[cIdx + a]);
                                cMax[a] = Math.max(cMax[a], centroids[cIdx + a]);
                            }
                        }

                        for (let a = 0; a < 3; a++) {
                            let bMin = cMin[a], bMax = cMax[a];
                            if (bMax - bMin < 0.0001) continue;

                            let binCounts = new Array(BINS).fill(0);
                            let binBoundsMin = Array.from({ length: BINS }, () => [Infinity, Infinity, Infinity]);
                            let binBoundsMax = Array.from({ length: BINS }, () => [-Infinity, -Infinity, -Infinity]);

                            for (let i = 0; i < node.triCount; i++) {
                                let triIdx = triIndices[node.leftFirst + i];
                                let c = centroids[triIdx * 3 + a];
                                let binIdx = Math.floor(BINS * ((c - bMin) / (bMax - bMin)));
                                binIdx = Math.min(BINS - 1, Math.max(0, binIdx));

                                binCounts[binIdx]++;
                                let tri = meshTriangles[triIdx];
                                for (let v = 0; v < 3; v++) {
                                    for (let ax = 0; ax < 3; ax++) {
                                        binBoundsMin[binIdx][ax] = Math.min(binBoundsMin[binIdx][ax], tri[v][ax]);
                                        binBoundsMax[binIdx][ax] = Math.max(binBoundsMax[binIdx][ax], tri[v][ax]);
                                    }
                                }
                            }

                            let leftArea = new Array(BINS - 1).fill(0);
                            let leftCount = new Array(BINS - 1).fill(0);
                            let lBoxMin = [Infinity, Infinity, Infinity], lBoxMax = [-Infinity, -Infinity, -Infinity];
                            let sumCount = 0;

                            for (let i = 0; i < BINS - 1; i++) {
                                sumCount += binCounts[i];
                                if (binCounts[i] > 0) {
                                    for (let ax = 0; ax < 3; ax++) {
                                        lBoxMin[ax] = Math.min(lBoxMin[ax], binBoundsMin[i][ax]);
                                        lBoxMax[ax] = Math.max(lBoxMax[ax], binBoundsMax[i][ax]);
                                    }
                                }
                                leftCount[i] = sumCount;
                                leftArea[i] = sumCount > 0 ? getSurfaceArea(lBoxMin, lBoxMax) : 0;
                            }

                            let rBoxMin = [Infinity, Infinity, Infinity], rBoxMax = [-Infinity, -Infinity, -Infinity];
                            sumCount = 0;

                            for (let i = BINS - 1; i > 0; i--) {
                                sumCount += binCounts[i];
                                if (binCounts[i] > 0) {
                                    for (let ax = 0; ax < 3; ax++) {
                                        rBoxMin[ax] = Math.min(rBoxMin[ax], binBoundsMin[i][ax]);
                                        rBoxMax[ax] = Math.max(rBoxMax[ax], binBoundsMax[i][ax]);
                                    }
                                }
                                let rightArea = sumCount > 0 ? getSurfaceArea(rBoxMin, rBoxMax) : 0;

                                // SAH Cost Formula
                                let cost = leftArea[i - 1] * leftCount[i - 1] + rightArea * sumCount;

                                if (cost < bestCost) {
                                    bestCost = cost;
                                    axis = a;
                                    splitPos = bMin + (i / BINS) * (bMax - bMin);
                                }
                            }
                        }
                        if (bestCost === Infinity) useSpatialFallback = true;
                    }

                    if (useSpatialFallback) {
                        let extents = [node.max[0] - node.min[0], node.max[1] - node.min[1], node.max[2] - node.min[2]];
                        if (extents[1] > extents[0]) axis = 1;
                        if (extents[2] > extents[axis]) axis = 2;
                        splitPos = node.min[axis] + extents[axis] * 0.5;
                    }

                    // Apply chosen split
                    let i = node.leftFirst, j = i + node.triCount - 1;
                    while (i <= j) {
                        let triIdx = triIndices[i];
                        if (centroids[triIdx * 3 + axis] < splitPos) { i++; }
                        else {
                            let temp = triIndices[i];
                            triIndices[i] = triIndices[j];
                            triIndices[j] = temp;
                            j--;
                        }
                    }

                    let leftCount = i - node.leftFirst;
                    if (leftCount == 0 || leftCount == node.triCount) {
                        leftCount = Math.floor(node.triCount / 2);
                        i = node.leftFirst + leftCount;
                    }

                    let leftChildIdx = nodesUsed++;
                    let rightChildIdx = nodesUsed++;

                    bvhNodes[leftChildIdx] = { min: [0, 0, 0], max: [0, 0, 0], leftFirst: node.leftFirst, triCount: leftCount, parent: nodeIdx };
                    bvhNodes[rightChildIdx] = { min: [0, 0, 0], max: [0, 0, 0], leftFirst: i, triCount: node.triCount - leftCount, parent: nodeIdx };

                    node.leftFirst = leftChildIdx;
                    node.triCount = 0;

                    updateNodeBounds(leftChildIdx);
                    updateNodeBounds(rightChildIdx);

                    subdivide(leftChildIdx);
                    subdivide(rightChildIdx);
                }

                updateNodeBounds(0);
                subdivide(0);

                let orderedTriangles = [];
                for (let i = 0; i < N; i++) { orderedTriangles.push(meshTriangles[triIndices[i]]); }
                return { nodes: bvhNodes, triangles: orderedTriangles, order: triIndices };
            }


            function parseMTL(str) {
                const materials = {};
                let currentMat = null;
                str.split('\n').forEach(line => {
                    line = line.split('#')[0].trim();
                    if (!line) return;
                    const p = line.split(/\s+/);

                    if (line.startsWith('newmtl ')) {
                        currentMat = line.substring(7).trim();
                        materials[currentMat] = { color: [1, 1, 1], smoothness: 0.0, emColor: [0, 0, 0], emStrength: 0.0, trans: 0.0, ior: 1.5 };
                    } else if (currentMat) {
                        if (p[0] === 'Kd') materials[currentMat].color = [parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])];
                        if (p[0] === 'Ke') {
                            let r = parseFloat(p[1]), g = parseFloat(p[2]), b = parseFloat(p[3]);
                            let maxVal = Math.max(r, g, b);
                            if (maxVal > 0) { materials[currentMat].emColor = [r / maxVal, g / maxVal, b / maxVal]; materials[currentMat].emStrength = maxVal; }
                            else { materials[currentMat].emColor = [0, 0, 0]; materials[currentMat].emStrength = 0.0; }
                        }
                        if (p[0] === 'Ns') { let ns = parseFloat(p[1]); if (ns > 0) materials[currentMat].smoothness = Math.min(1.0, Math.pow(ns / 1000.0, 0.33)); }
                        if (p[0] === 'Pr') materials[currentMat].smoothness = 1.0 - parseFloat(p[1]);
                        if (p[0] === 'd' || p[0] === 'Tr') materials[currentMat].trans = p[0] === 'd' ? 1.0 - parseFloat(p[1]) : parseFloat(p[1]);
                        if (p[0] === 'Ni') materials[currentMat].ior = parseFloat(p[1]);

                        if (p[0] === 'map_Kd') materials[currentMat].map_Kd = p[p.length - 1];
                        if (p[0] === 'map_Bump' || p[0] === 'bump') materials[currentMat].map_Bump = p[p.length - 1];
                    }
                });
                return materials;
            }

            async function loadOBJFromURL(url, isSmooth = true, mtl = true) {
                try {
                    const response = await fetch(url);
                    if (!response.ok) throw new Error(`Failed to load OBJ`);
                    const objString = await response.text();
                    const objData = parseOBJ(objString);

                    let mtlUrl = null;
                    if (typeof mtl === 'string') mtlUrl = new URL(mtl, url).href;
                    else if (mtl === true) {
                        if (objData.mtllib) mtlUrl = new URL(objData.mtllib, url).href;
                        else mtlUrl = url.replace(/\.obj$/i, '.mtl');
                    }

                    if (mtlUrl) {
                        try {
                            const mtlResponse = await fetch(mtlUrl);
                            if (mtlResponse.ok) {
                                const mtlString = await mtlResponse.text();
                                const materials = parseMTL(mtlString);

                                const group = new Group();
                                for (let matName in objData.groups) {
                                    if (objData.groups[matName].length === 0) continue;
                                    let mesh = new MeshObject(objData.groups[matName], isSmooth);
                                    if (materials[matName]) {
                                        let m = materials[matName];
                                        mesh.set_material(m.color, m.smoothness, m.trans, m.ior, m.emColor, m.emStrength);
                                        if (m.map_Kd) mesh.albedoUrl = new URL(m.map_Kd, mtlUrl).href;
                                        if (m.map_Bump) mesh.normalUrl = new URL(m.map_Bump, mtlUrl).href;
                                    }
                                    group.add(mesh);
                                }
                                return group;
                            }
                        } catch (e) { console.warn("Failed to load MTL, falling back to default.", e); }
                    }
                    return new MeshObject(objData, isSmooth);
                } catch (error) { console.warn("Error fetching OBJ model.", error); return null; }
            }

            function parseOBJ(str) {
                const verts = [], normals = [], uvs = [];
                const faces = [];
                const faceMaterials = [];

                let hasNormals = false, hasUVs = false;
                let currentMaterial = 'default';
                let mtllib = null;

                str.split('\n').forEach(line => {
                    line = line.split('#')[0].trim();
                    if (!line) return;

                    const p = line.split(/\s+/);
                    if (line.startsWith('mtllib ')) mtllib = line.substring(7).trim();
                    else if (line.startsWith('usemtl ')) currentMaterial = line.substring(7).trim();
                    else if (p[0] === 'v') verts.push([parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])]);
                    else if (p[0] === 'vn') { normals.push([parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])]); hasNormals = true; }
                    else if (p[0] === 'vt') { uvs.push([parseFloat(p[1]), parseFloat(p[2])]); hasUVs = true; }
                    else if (p[0] === 'f') {
                        for (let i = 2; i < p.length - 1; i++) {
                            faces.push([p[1], p[i], p[i + 1]]);
                            faceMaterials.push(currentMaterial);
                        }
                    }
                });

                let vertexNormals = [];
                if (!hasNormals) vertexNormals = Array(verts.length).fill(0).map(() => [0, 0, 0]);

                const parsedTris = [];
                faces.forEach((f, idx) => {
                    let v_idx = [], n_idx = [], t_idx = [];
                    for (let i = 0; i < 3; i++) {
                        let parts = f[i].split('/');
                        let vi = parseInt(parts[0]); vi = (vi < 0) ? (verts.length + vi) : (vi - 1); v_idx.push(vi);

                        if (hasUVs && parts[1]) { let ti = parseInt(parts[1]); ti = (ti < 0) ? (uvs.length + ti) : (ti - 1); t_idx.push(ti); }
                        else { t_idx.push(-1); }

                        if (hasNormals && parts[2]) { let ni = parseInt(parts[2]); ni = (ni < 0) ? (normals.length + ni) : (ni - 1); n_idx.push(ni); }
                        else { n_idx.push(vi); }
                    }

                    if (!hasNormals) {
                        let v0 = verts[v_idx[0]], v1 = verts[v_idx[1]], v2 = verts[v_idx[2]];
                        if (v0 && v1 && v2) {
                            let dx1 = v1[0] - v0[0], dy1 = v1[1] - v0[1], dz1 = v1[2] - v0[2]; let dx2 = v2[0] - v0[0], dy2 = v2[1] - v0[1], dz2 = v2[2] - v0[2];
                            let nx = dy1 * dz2 - dz1 * dy2, ny = dz1 * dx2 - dx1 * dz2, nz = dx1 * dy2 - dy1 * dx2;
                            for (let i = 0; i < 3; i++) { if (vertexNormals[v_idx[i]]) { vertexNormals[v_idx[i]][0] += nx; vertexNormals[v_idx[i]][1] += ny; vertexNormals[v_idx[i]][2] += nz; } }
                        }
                    }
                    parsedTris.push({ v: v_idx, n: n_idx, t: t_idx, mat: faceMaterials[idx] });
                });

                if (!hasNormals) {
                    for (let i = 0; i < vertexNormals.length; i++) {
                        let len = Math.hypot(vertexNormals[i][0], vertexNormals[i][1], vertexNormals[i][2]);
                        if (len > 0) { vertexNormals[i][0] /= len; vertexNormals[i][1] /= len; vertexNormals[i][2] /= len; } else { vertexNormals[i] = [0, 1, 0]; }
                    }
                }

                const finalTriangles = [];
                finalTriangles.groups = {};
                finalTriangles.mtllib = mtllib;

                parsedTris.forEach(t => {
                    let v0 = verts[t.v[0]], v1 = verts[t.v[1]], v2 = verts[t.v[2]];
                    if (!v0 || !v1 || !v2) return;
                    let n0, n1, n2;
                    if (hasNormals) { n0 = normals[t.n[0]] || [0, 1, 0]; n1 = normals[t.n[1]] || [0, 1, 0]; n2 = normals[t.n[2]] || [0, 1, 0]; }
                    else { n0 = vertexNormals[t.n[0]] || [0, 1, 0]; n1 = vertexNormals[t.n[1]] || [0, 1, 0]; n2 = vertexNormals[t.n[2]] || [0, 1, 0]; }

                    let uv0 = (t.t[0] !== -1) ? uvs[t.t[0]] : [0, 0];
                    let uv1 = (t.t[1] !== -1) ? uvs[t.t[1]] : [0, 0];
                    let uv2 = (t.t[2] !== -1) ? uvs[t.t[2]] : [0, 0];

                    let tri = [v0, v1, v2, n0, n1, n2, uv0, uv1, uv2];
                    finalTriangles.push(tri);

                    let m = t.mat || 'default';
                    if (!finalTriangles.groups[m]) finalTriangles.groups[m] = [];
                    finalTriangles.groups[m].push(tri);
                });

                return finalTriangles;
            }

            function loadOBJFromString(objString, mtlString = null, isSmooth = true) {
                const objData = parseOBJ(objString);
                if (mtlString) {
                    const materials = parseMTL(mtlString);
                    const group = new Group();
                    for (let matName in objData.groups) {
                        if (objData.groups[matName].length === 0) continue;
                        let mesh = new MeshObject(objData.groups[matName], isSmooth);
                        if (materials[matName]) {
                            let m = materials[matName];
                            mesh.set_material(m.color, m.smoothness, m.trans, m.ior, m.emColor, m.emStrength);
                        }
                        group.add(mesh);
                    }
                    return group;
                }
                return new MeshObject(objData, isSmooth);
            }

            function generateProceduralSphere(radius, radialSegments, tubularSegments) {
                const vertices = [], normals = [], tris = [];
                for (let i = 0; i <= radialSegments; i++) {
                    let u = (i / radialSegments) * Math.PI * 2;
                    for (let j = 0; j <= tubularSegments; j++) {
                        let v = (j / tubularSegments) * Math.PI;
                        let x = radius * Math.sin(v) * Math.cos(u); let y = radius * Math.sin(v) * Math.sin(u); let z = radius * Math.cos(v);
                        vertices.push([x, y, z]); normals.push(Math3D.normalize([x, y, z]));
                    }
                }
                for (let i = 0; i < radialSegments; i++) {
                    for (let j = 0; j < tubularSegments; j++) {
                        let p1 = i * (tubularSegments + 1) + j, p2 = p1 + 1; let p3 = (i + 1) * (tubularSegments + 1) + j, p4 = p3 + 1;
                        tris.push([vertices[p1], vertices[p2], vertices[p3], normals[p1], normals[p2], normals[p3]]);
                        tris.push([vertices[p2], vertices[p4], vertices[p3], normals[p2], normals[p4], normals[p3]]);
                    }
                }
                return tris;
            }

            function generateProceduralTorus(R, r, radialSegments, tubularSegments) {
                const vertices = [];
                const normals = [];
                const tris = [];

                for (let i = 0; i <= radialSegments; i++) {
                    let theta = (i / radialSegments) * Math.PI * 2;
                    let cosTheta = Math.cos(theta); let sinTheta = Math.sin(theta);
                    for (let j = 0; j <= tubularSegments; j++) {
                        let phi = (j / tubularSegments) * Math.PI * 2;
                        let cosPhi = Math.cos(phi); let sinPhi = Math.sin(phi);

                        let x = (R + r * cosPhi) * cosTheta; let y = (R + r * cosPhi) * sinTheta; let z = r * sinPhi;
                        vertices.push([x, y, z]);
                        let nx = cosPhi * cosTheta; let ny = cosPhi * sinTheta; let nz = sinPhi;
                        normals.push([nx, ny, nz]);
                    }
                }

                for (let i = 0; i < radialSegments; i++) {
                    for (let j = 0; j < tubularSegments; j++) {
                        let stride = tubularSegments + 1;
                        let p1 = i * stride + j; let p2 = p1 + 1; let p3 = (i + 1) * stride + j; let p4 = p3 + 1;
                        tris.push([vertices[p1], vertices[p3], vertices[p2], normals[p1], normals[p3], normals[p2]]);
                        tris.push([vertices[p2], vertices[p3], vertices[p4], normals[p2], normals[p3], normals[p4]]);
                    }
                }
                return tris;
            }

            function createSDFTexture(device) {
                const size = 64;
                const data = new Uint8Array(size * size * 4);
                for (let y = 0; y < size; y++) {
                    for (let x = 0; x < size; x++) {
                        let u = (x / size) * 2 - 1; let v = (y / size) * 2 - 1;
                        let dist = Math.abs(Math.sqrt(u * u + v * v) - 0.5) - 0.15;
                        let val = 128 - dist * 255;
                        let c = Math.max(0, Math.min(255, val));
                        let i = (y * size + x) * 4;
                        data[i] = c; data[i + 1] = c; data[i + 2] = c; data[i + 3] = 255;
                    }
                }
                const texture = device.createTexture({
                    size: [size, size, 1], format: 'rgba8unorm',
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
                });
                device.queue.writeTexture({ texture }, data, { bytesPerRow: size * 4 }, [size, size, 1]);
                return texture;
            }

            // ==========================================
            // WGSL Shaders & Common Logic
            // ==========================================
            const wgsl_common = `
            
            struct Camera { 
                pos: vec4<f32>, dir: vec4<f32>, up: vec4<f32>, right: vec4<f32>, 
                resFovFrame: vec4<f32>, counts: vec4<f32>, dof: vec4<f32>,
                skyData: vec4<f32>, giData: vec4<f32>,
                prevPos: vec4<f32>, prevDir: vec4<f32>, prevUp: vec4<f32>, prevRight: vec4<f32>,
                extra: vec4<f32> // <-- ADD THIS
            }

            struct Sphere { posRad: vec4<f32>, prevPosRad: vec4<f32>, mat0: vec4<f32>, mat1: vec4<f32>, mat2: vec4<f32> }

            struct Mesh { 
                invModelMatrix: mat4x4<f32>, modelMatrix: mat4x4<f32>, prevModelMatrix: mat4x4<f32>, 
                aabbMin: vec4<f32>, aabbMax: vec4<f32>, mat0: vec4<f32>, mat1: vec4<f32>, mat2: vec4<f32>, triData: vec4<f32> 
            }

            struct HitRecord { 
                hit: bool, dist: f32, point: vec3<f32>, normal: vec3<f32>, mat: Material,
                objId: u32, isSphere: u32 
            }
            struct Triangle { v0: vec4<f32>, v1: vec4<f32>, v2: vec4<f32>, n0: vec4<f32>, n1: vec4<f32>, n2: vec4<f32> }
            
            struct BVHNode {
                aabbMin: vec3<f32>, leftFirst: u32,
                aabbMax: vec3<f32>, triCount: u32,
                parentIdx: i32, isLeaf: u32, pad1: u32, pad2: u32
            }
            
            struct Ray { origin: vec3<f32>, dir: vec3<f32>, invDir: vec3<f32> }
            struct Material { color: vec3<f32>, smoothness: f32, emColor: vec3<f32>, emStrength: f32, trans: f32, ior: f32, metallic: f32 }

            // --- ReSTIR Reservoir Data Structure ---
            struct Reservoir {
                y_point: vec4<f32>,    // xyz: ray direction, w: weight sum (w_sum)
                y_normal: vec4<f32>,   // xyz: brdf weight, w: final RIS weight (W)
                y_radiance: vec4<f32>, // xyz: emitted/bounced radiance, w: bitcast<f32>(M) count
            }

            fn updateReservoir(r: ptr<function, Reservoir>, point: vec4<f32>, normal: vec4<f32>, radiance: vec3<f32>, weight: f32, rng: ptr<function, u32>) -> bool {
                (*r).y_point.w += weight; 
                
                var M = bitcast<u32>((*r).y_radiance.w);
                M += 1u;
                (*r).y_radiance.w = bitcast<f32>(M);

                if ((*r).y_point.w > 0.0 && rand_float(rng) < (weight / (*r).y_point.w)) {
                    (*r).y_point = vec4<f32>(point.xyz, (*r).y_point.w);
                    (*r).y_normal = vec4<f32>(normal.xyz, (*r).y_normal.w);
                    (*r).y_radiance = vec4<f32>(radiance, (*r).y_radiance.w);
                    return true;
                }
                return false;
            }

            fn mergeReservoir(r: ptr<function, Reservoir>, new_r: Reservoir, p_hat: f32, rng: ptr<function, u32>) {
                let M_new = bitcast<u32>(new_r.y_radiance.w);
                let weight = p_hat * new_r.y_normal.w * f32(M_new);
                
                (*r).y_point.w += weight;
                
                var M_current = bitcast<u32>((*r).y_radiance.w);
                (*r).y_radiance.w = bitcast<f32>(M_current + M_new);
                
                if ((*r).y_point.w > 0.0 && rand_float(rng) < (weight / (*r).y_point.w)) {
                    (*r).y_point = vec4<f32>(new_r.y_point.xyz, (*r).y_point.w);
                    (*r).y_normal = vec4<f32>(new_r.y_normal.xyz, (*r).y_normal.w);
                    (*r).y_radiance = vec4<f32>(new_r.y_radiance.xyz, (*r).y_radiance.w);
                }
            }
            fn computeW(r: ptr<function, Reservoir>, p_hat: f32) {
                let M = f32(bitcast<u32>((*r).y_radiance.w));
                if (p_hat == 0.0) {
                    (*r).y_normal.w = 0.0;
                } else {
                    (*r).y_normal.w = min((*r).y_point.w / (M * p_hat), 20.0); 
                }
            }
            
            // fn eval_contribution(dir: vec3<f32>, L_i: vec3<f32>, normal: vec3<f32>, albedo: vec3<f32>, smoothness: f32, viewDir: vec3<f32>) -> vec3<f32> {
            //     if (dot(normal, dir) <= 0.0) { return vec3<f32>(0.0); }
            //     let specColor = mix(vec3<f32>(1.0), albedo, smoothness);
            //     let expected_brdf_weight = mix(albedo, specColor, smoothness);
            //     return expected_brdf_weight * L_i;
            // }

            fn eval_contribution(dir: vec3<f32>, L_i: vec3<f32>, normal: vec3<f32>, albedo: vec3<f32>, smoothness: f32, metallic: f32, viewDir: vec3<f32>) -> vec3<f32> {
                if (dot(normal, dir) <= 0.0) { return vec3<f32>(0.0); }
                
                // USE METALLIC HERE: 0.0 = White reflection (Plastic), 1.0 = Colored reflection (Metal)
                let specColor = mix(vec3<f32>(1.0), albedo, metallic);
                let expected_brdf_weight = mix(albedo, specColor, smoothness);
                
                return expected_brdf_weight * L_i;
            }


            // fn eval_contribution(L: vec3<f32>, L_i: vec3<f32>, N: vec3<f32>, albedo: vec3<f32>, smoothness: f32, V: vec3<f32>) -> vec3<f32> {
            //     let NdotL = dot(N, L);
            //     // If light is behind the surface, there is no contribution
            //     if (NdotL <= 0.0) { return vec3<f32>(0.0); }
                
            //     // Clamp NdotV to prevent division by zero artifacts at grazing angles
            //     let NdotV = max(dot(N, V), 0.0001);
                
            //     let H = normalize(V + L);
            //     let NdotH = max(dot(N, H), 0.0);
            //     let VdotH = max(dot(V, H), 0.0);
                
            //     // Perceptual smoothness to linear roughness (Disney/Epic mapping)
            //     // Clamped to 0.02 to prevent extreme specular fireflies in ReSTIR
            //     let roughness = clamp(1.0 - smoothness, 0.02, 1.0);
            //     let alpha = roughness * roughness;
            //     let alpha2 = alpha * alpha;
                
            //     let PI = 3.14159265359;
                
            //     // --- 1. Fresnel (Schlick's Approximation) ---
            //     // F0 is base reflectivity. 0.04 is the standard for dielectrics (plastics/glass).
            //     // Note: If you add a 'metallic' property later, change this to: mix(vec3(0.04), albedo, metallic)
            //     let F0 = vec3<f32>(0.04);
            //     let F = F0 + (1.0 - F0) * pow(clamp(1.0 - VdotH, 0.0, 1.0), 5.0);
                
            //     // --- 2. Normal Distribution Function (GGX) ---
            //     // Determines the alignment of microfacets towards the Half-vector
            //     let denom = (NdotH * NdotH * (alpha2 - 1.0) + 1.0);
            //     let D = alpha2 / (PI * denom * denom);
                
            //     // --- 3. Geometry / Shadowing-Masking (Smith-Schlick GGX) ---
            //     // For indirect GI (which ReSTIR handles), k = alpha / 2.0 is mathematically correct
            //     let k = alpha / 2.0; 
            //     let ggx1 = NdotV / (NdotV * (1.0 - k) + k);
            //     let ggx2 = NdotL / (NdotL * (1.0 - k) + k);
            //     let G = ggx1 * ggx2;
                
            //     // --- 4. Cook-Torrance Specular Lobe ---
            //     let specular = (D * F * G) / (4.0 * NdotV * NdotL + 0.0001);
                
            //     // --- 5. Energy Conserving Diffuse (Lambert) ---
            //     // Whatever energy is reflected by specular (F) cannot enter the surface to become diffuse
            //     let kS = F;
            //     let kD = vec3<f32>(1.0) - kS; 
            //     let diffuse = kD * (albedo / PI);
                
            //     // --- Final BRDF ---
            //     let brdf = diffuse + specular;
                
            //     // The Rendering Equation: BRDF * Radiance * cos(theta)
            //     return brdf * L_i * NdotL;
            // }


            //Fast
            // Locate this inside your wgsl_common string
            // fn eval_contribution(dir: vec3<f32>, L_i: vec3<f32>, normal: vec3<f32>, albedo: vec3<f32>, smoothness: f32, viewDir: vec3<f32>) -> vec3<f32> {
            //     let NdotL = max(dot(normal, dir), 0.0);
            //     if (NdotL <= 0.0) { return vec3<f32>(0.0); }

            //     let H = normalize(viewDir + dir);
            //     let NdotH = max(dot(normal, H), 0.0);
            //     let VdotH = max(dot(viewDir, H), 0.0);

            //     // Roughness mapping (squared for perceptual linearity)
            //     let alpha = max((1.0 - smoothness) * (1.0 - smoothness), 0.001);
            //     let alpha2 = alpha * alpha;

            //     // Fast Fresnel (Multiplication instead of Pow)
            //     let fc = 1.0 - VdotH;
            //     let fc2 = fc * fc;
            //     let fc5 = fc2 * fc2 * fc;
            //     let F = vec3<f32>(0.04) + vec3<f32>(0.96) * fc5; 

            //     // Fast GGX Normal Distribution
            //     let denom = NdotH * NdotH * (alpha2 - 1.0) + 1.0;
            //     let D = alpha2 / (3.1415926 * denom * denom);

            //     // Ultra-Fast Specular (Denominator cancelled by Implicit G)
            //     let specular = (D * F) * 0.25;

            //     // Energy Conserving Diffuse (Lambert)
            //     let kD = (vec3<f32>(1.0) - F);
            //     let diffuse = kD * albedo * 0.318309; // 0.318309 is 1/PI

            //     return (diffuse + specular) * L_i * NdotL;
            // }

// fn eval_contribution(L: vec3<f32>, L_i: vec3<f32>, N: vec3<f32>, albedo: vec3<f32>, smoothness: f32, V: vec3<f32>) -> vec3<f32> {
//     let NdotL = max(dot(N, L), 0.0);
//     if (NdotL <= 0.0) { return vec3<f32>(0.0); }

//     // Your original, clean stylized color blending
//     let specColor = mix(vec3<f32>(1.0), albedo, smoothness);
    
//     // Stable Blinn-Phong highlight (Zero noise, fast convergence)
//     let H = normalize(V + L);
//     let NdotH = max(dot(N, H), 0.0);
//     let specPower = exp2(10.0 * smoothness + 1.0);
//     let specIntensity = pow(NdotH, specPower) * smoothness;

//     let diffuse = albedo * (1.0 - smoothness);
//     let specular = specColor * specIntensity;

//     return (diffuse + specular) * L_i * NdotL;
// }

            

            @group(0) @binding(0) var<uniform> cam: Camera;
            @group(0) @binding(1) var<storage, read> spheres: array<Sphere>;
            @group(0) @binding(2) var<storage, read> meshes: array<Mesh>;
            @group(0) @binding(3) var<storage, read> triangles: array<Triangle>;
            @group(0) @binding(4) var<storage, read> bvhNodes: array<BVHNode>;
            @group(0) @binding(5) var atlasTex: texture_2d<f32>;
            @group(0) @binding(6) var msdfTex: texture_2d<f32>;
            @group(0) @binding(7) var texSampler: sampler;
            @group(0) @binding(8) var albedoTextures: texture_2d_array<f32>;
            @group(0) @binding(9) var normalTextures: texture_2d_array<f32>;

            fn pcg_hash(seed: ptr<function, u32>) -> u32 {
                var state = *seed * 747796405u + 2891336453u;
                var word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
                *seed = (word >> 22u) ^ word; return *seed;
            }
            fn rand_float(seed: ptr<function, u32>) -> f32 { return f32(pcg_hash(seed)) / 4294967295.0; }
            fn rand_in_unit_disk(seed: ptr<function, u32>) -> vec2<f32> {
                var p: vec2<f32>;
                for(var i=0; i<10; i++) {
                    p = vec2<f32>(rand_float(seed)*2.0-1.0, rand_float(seed)*2.0-1.0);
                    if (dot(p, p) < 1.0) { return p; }
                }
                return vec2<f32>(0.0);
            }
            fn rand_unit_vector(seed: ptr<function, u32>) -> vec3<f32> {
                let z = rand_float(seed) * 2.0 - 1.0; let a = rand_float(seed) * 6.28318530718; let r = sqrt(max(0.0, 1.0 - z * z));
                return vec3<f32>(r * cos(a), r * sin(a), z);
            }

            fn intersectSphere(ray: Ray, s: Sphere) -> HitRecord {
                var rec: HitRecord; rec.hit = false;
                let oc = ray.origin - s.posRad.xyz;
                let a = dot(ray.dir, ray.dir);
                let half_b = dot(oc, ray.dir);
                let c = dot(oc, oc) - s.posRad.w * s.posRad.w;
                let discriminant = half_b * half_b - a * c;

                if (discriminant > 0.0) {
                    var root = (-half_b - sqrt(discriminant)) / a;
                    if (root < 0.001 || root > 1000.0) { root = (-half_b + sqrt(discriminant)) / a; }
                    if (root > 0.001 && root < 1000.0) {
                        rec.hit = true; rec.dist = root;
                        rec.point = ray.origin + root * ray.dir;
                        rec.normal = normalize(rec.point - s.posRad.xyz);
                        if (dot(rec.normal, ray.dir) > 0.0) { rec.normal = -rec.normal; }

                        rec.mat.color = s.mat0.rgb; rec.mat.smoothness = s.mat0.a;
                        rec.mat.emColor = s.mat1.rgb; rec.mat.emStrength = s.mat1.a;
                        rec.mat.trans = s.mat2.x; rec.mat.ior = max(1.0, s.mat2.y); rec.mat.metallic = s.mat2.z;
                        return rec;
                    }
                }
                return rec;
            }

            fn intersectAABB(ray: Ray, boxMin: vec3<f32>, boxMax: vec3<f32>, tMax: f32) -> bool {
                let t0 = (boxMin - ray.origin) * ray.invDir; 
                let t1 = (boxMax - ray.origin) * ray.invDir;
                let tmin = min(t0, t1); let tmax = max(t0, t1);
                let tnear = max(max(tmin.x, tmin.y), tmin.z); let tfar = min(min(tmax.x, tmax.y), tmax.z);
                return tfar >= max(0.0, tnear) && tnear < tMax;
            }

            fn intersectAABBDist(ray: Ray, boxMin: vec3<f32>, boxMax: vec3<f32>, tMax: f32) -> f32 {
                let t0 = (boxMin - ray.origin) * ray.invDir; 
                let t1 = (boxMax - ray.origin) * ray.invDir;
                let tmin = min(t0, t1); let tmax = max(t0, t1);
                let tnear = max(max(tmin.x, tmin.y), tmin.z); let tfar = min(min(tmax.x, tmax.y), tmax.z);
                if (tfar >= max(0.0, tnear) && tnear < tMax) { return max(0.0, tnear); }
                return 999999.0;
            }

            fn intersectTriangle(ray: Ray, tri: Triangle) -> vec3<f32> {
                let edge1 = tri.v1.xyz - tri.v0.xyz; let edge2 = tri.v2.xyz - tri.v0.xyz;
                let h = cross(ray.dir, edge2); let a = dot(edge1, h);
                if (a > -0.00001 && a < 0.00001) { return vec3(-1.0); }
                let f = 1.0 / a; let s = ray.origin - tri.v0.xyz; let u = f * dot(s, h);
                if (u < 0.0 || u > 1.0) { return vec3(-1.0); }
                let q = cross(s, edge1); let v = f * dot(ray.dir, q);
                if (v < 0.0 || u + v > 1.0) { return vec3(-1.0); }
                let t = f * dot(edge2, q);
                if (t > 0.001) { return vec3(t, u, v); } 
                return vec3(-1.0);
            }

            fn worldHit(ray: Ray, rngState: ptr<function, u32>) -> HitRecord {
                var closest: HitRecord; closest.hit = false; closest.dist = 999999.0;
                let rt_enabled_bool = cam.counts.w > 0.5;

                for (var i: u32 = 0u; i < u32(cam.counts.x); i++) {
                    let s = spheres[i];
                    if (s.posRad.w <= 0.0002) { continue; } 

                    // let opacity = s.mat2.w;
                    // if (opacity < 1.0) {
                    //     if (!rt_enabled_bool && opacity < 0.5) { continue; } // Preview mode dithering
                    //     if (rt_enabled_bool && rand_float(rngState) > opacity) { continue; } // RT mode true fade
                    // }

                    let rec = intersectSphere(ray, s);
                    if (rec.hit && rec.dist < closest.dist) { closest = rec; closest.objId = i; closest.isSphere = 1u; }
                }

                for (var i: u32 = 0u; i < u32(cam.counts.y); i++) {
                    let mesh = meshes[i];
                    if (mesh.aabbMax.x - mesh.aabbMin.x < 0.0001 && mesh.aabbMax.y - mesh.aabbMin.y < 0.0001) { continue; }
                    if (!intersectAABB(ray, mesh.aabbMin.xyz, mesh.aabbMax.xyz, closest.dist)) { continue; }

                    var localRay: Ray;
                    localRay.origin = (mesh.invModelMatrix * vec4<f32>(ray.origin, 1.0)).xyz;
                    localRay.dir = (mesh.invModelMatrix * vec4<f32>(ray.dir, 0.0)).xyz;
                    localRay.invDir = 1.0 / localRay.dir;

                    let mat2_z = mesh.mat2.z;
let vectorType = i32(mat2_z % 10.0);
let isVector = vectorType > 0;
let isSmooth = mat2_z >= 10.0;

                    var stack: array<u32, 64>; var stackPtr = 0u;
                    stack[stackPtr] = u32(mesh.triData.x); stackPtr++;

                    while(stackPtr > 0u) {
                        stackPtr--;
                        let nodeIdx = stack[stackPtr];
                        let node = bvhNodes[nodeIdx];

                        if (!intersectAABB(localRay, node.aabbMin, node.aabbMax, closest.dist)) { continue; }

                        if (node.triCount > 0u) {
                            let firstTri = node.leftFirst;
                            for (var t: u32 = 0u; t < node.triCount; t++) {
                                let tri = triangles[firstTri + t];
                                let res = intersectTriangle(localRay, tri);
                                
                                if (res.x > 0.001 && res.x < closest.dist) {
                                    var isValidHit = true;
                                    var texColor = vec4<f32>(1.0);
                                    
                                    // let meshOpacity = mesh.aabbMin.w;
                                    // if (meshOpacity < 1.0) {
                                    //     if (!rt_enabled_bool) {
                                    //         if (meshOpacity < 0.5) { isValidHit = false; }
                                    //     } else {
                                    //         if (rand_float(rngState) > meshOpacity) { isValidHit = false; }
                                    //     }
                                    // }

                                    if (isVector) {
                                        let w = 1.0 - res.y - res.z;
                                        let uv = vec2<f32>(tri.v0.w, tri.n0.w) * w + vec2<f32>(tri.v1.w, tri.n1.w) * res.y + vec2<f32>(tri.v2.w, tri.n2.w) * res.z;
                                        var alpha = 1.0;

                                        if (vectorType == 1) { 
                                            texColor = textureSampleLevel(atlasTex, texSampler, uv, 0.0);
                                            alpha = texColor.a;
                                        } else if (vectorType == 2) { 
                                            let msd = textureSampleLevel(msdfTex, texSampler, uv, 0.0).rgb;
                                            let dist = max(min(msd.r, msd.g), min(max(msd.r, msd.g), msd.b)) - 0.5;
                                            alpha = clamp(dist * 50.0 + 0.5, 0.0, 1.0);
                                        } else if (vectorType == 3) {
                                            // Loop-Blinn Analytic Bezier Evaluation
                                            let u = uv.x;
                                            let v = uv.y;
                                            let f = u * u - v;
                                            
                                            // Gradient magnitude of f(u,v) = u^2 - v
                                            let grad_len = sqrt(4.0 * u * u + 1.0);
                                            
                                            // Approximate distance to the curve in UV space
                                            let dist = abs(f) / grad_len;

                                            // mesh.mat2.w can act as a toggle between FILL and STROKE
                                            let is_fill = mesh.mat2.w > 0.5;
                                            
                                            if (is_fill) {
                                                // FILL: Inside the curve is f < 0
                                                if (f < 0.0) { alpha = 1.0; } else { alpha = 0.0; }
                                            } else {
                                                // STROKE: Render a line of specific thickness
                                                // We use an arbitrary scale factor to convert UV distance to visual thickness
                                                let stroke_thickness = 0.05; 
                                                
                                                // Smooth anti-aliasing via step interpolation
                                                alpha = clamp(1.0 - (dist / stroke_thickness), 0.0, 1.0);
                                            }
                                        }

                                        // STOCHASTIC ALPHA TESTING (Perfect for Path Tracing)
                                        if (!rt_enabled_bool) {
                                            if (alpha < 0.5) { isValidHit = false; }
                                        } else {
                                            // Allows rays to randomly pass through anti-aliased edges, 
                                            // creating physically accurate soft shadows for vector graphics!
                                            if (rand_float(rngState) > alpha) { isValidHit = false; }
                                        }
                                    }

                                    if (isValidHit) {
                                        closest.hit = true; closest.dist = res.x;
                                        closest.objId = i; closest.isSphere = 0u;
                                        
                                        let w = 1.0 - res.y - res.z;
                                        let uv = vec2<f32>(tri.v0.w, tri.n0.w) * w + vec2<f32>(tri.v1.w, tri.n1.w) * res.y + vec2<f32>(tri.v2.w, tri.n2.w) * res.z;

                                        let albedoIdx = mesh.triData.z;
                                        let normalIdx = mesh.triData.w;

                                        if (albedoIdx >= 0.0) {
                                            texColor = textureSampleLevel(albedoTextures, texSampler, uv, i32(albedoIdx), 0.0);
                                            texColor = vec4<f32>(pow(texColor.rgb, vec3<f32>(2.2)), texColor.a); 
                                        }

                                        closest.mat.color = mesh.mat0.rgb * texColor.rgb;
                                        closest.mat.smoothness = mesh.mat0.a;
                                        closest.mat.emColor = mesh.mat1.rgb * texColor.rgb;
                                        closest.mat.emStrength = mesh.mat1.a;
                                        closest.mat.trans = mesh.mat2.x; 
closest.mat.ior = max(1.0, mesh.mat2.y);
closest.mat.metallic = mesh.mat2.w; // <- NEW


                                        let edge1 = tri.v1.xyz - tri.v0.xyz; 
                                        let edge2 = tri.v2.xyz - tri.v0.xyz;
                                        let localGeomNormal = normalize(cross(edge1, edge2));
                                        var worldGeomNormal = normalize((vec4<f32>(localGeomNormal, 0.0) * mesh.invModelMatrix).xyz);

                                        var localNormal: vec3<f32>;
                                        if (isSmooth) { localNormal = normalize(tri.n0.xyz * w + tri.n1.xyz * res.y + tri.n2.xyz * res.z); } 
                                        else { localNormal = localGeomNormal; }
                                        
                                        var finalNormal = normalize((vec4<f32>(localNormal, 0.0) * mesh.invModelMatrix).xyz);

                                        if (normalIdx >= 0.0) {
                                            let nMap = textureSampleLevel(normalTextures, texSampler, uv, i32(normalIdx), 0.0).xyz * 2.0 - 1.0;
                                            
                                            let uv0 = vec2<f32>(tri.v0.w, tri.n0.w);
                                            let uv1 = vec2<f32>(tri.v1.w, tri.n1.w);
                                            let uv2 = vec2<f32>(tri.v2.w, tri.n2.w);
                                            let deltaUV1 = uv1 - uv0; let deltaUV2 = uv2 - uv0;
                                            
                                            let f = 1.0 / (deltaUV1.x * deltaUV2.y - deltaUV2.x * deltaUV1.y + 0.00001);
                                            var tangent = normalize(f * (deltaUV2.y * edge1 - deltaUV1.y * edge2));
                                            tangent = normalize(tangent - dot(tangent, localNormal) * localNormal);
                                            let bitangent = cross(localNormal, tangent);
                                            
                                            let localBumpNormal = normalize(tangent * nMap.x + bitangent * nMap.y + localNormal * nMap.z);
                                            finalNormal = normalize((vec4<f32>(localBumpNormal, 0.0) * mesh.invModelMatrix).xyz);
                                        }

                                        if (dot(worldGeomNormal, ray.dir) > 0.0) {
                                            worldGeomNormal = -worldGeomNormal;
                                            finalNormal = -finalNormal;
                                        }
                                        let dot_sg = dot(finalNormal, worldGeomNormal);
                                        if (dot_sg < 0.1) {
                                            finalNormal = normalize(finalNormal + worldGeomNormal * (0.1 - dot_sg));
                                        }

                                        closest.normal = finalNormal;
                                    }
                                }
                            }
                        } else {
                            let leftIdx = node.leftFirst;
                            let rightIdx = node.pad1;
                            let leftNode = bvhNodes[leftIdx];
                            let rightNode = bvhNodes[rightIdx];

                            let tLeft = intersectAABBDist(localRay, leftNode.aabbMin, leftNode.aabbMax, closest.dist);
                            let tRight = intersectAABBDist(localRay, rightNode.aabbMin, rightNode.aabbMax, closest.dist);

                            if (tLeft < tRight) {
                                if (tRight < closest.dist) { stack[stackPtr] = rightIdx; stackPtr++; }
                                if (tLeft < closest.dist) { stack[stackPtr] = leftIdx; stackPtr++; }
                            } else {
                                if (tLeft < closest.dist) { stack[stackPtr] = leftIdx; stackPtr++; }
                                if (tRight < closest.dist) { stack[stackPtr] = rightIdx; stackPtr++; }
                            }
                        }
                    }
                }

                if (closest.hit) {
                    closest.point = ray.origin + closest.dist * ray.dir;
                }
                return closest;
            }
            
            fn get_camera_ray(pos: vec2<f32>, jitter: vec2<f32>, randDisk: vec2<f32>) -> Ray {
                var uv = (pos + jitter) / cam.resFovFrame.xy;
                uv = uv * 2.0 - 1.0;
                uv.y = -uv.y;

                // --- 1. LENS SHIFT (Tilt-Shift Effect) ---
                // Extracts ShiftX and ShiftY from giData
                uv.x += cam.giData.z; 
                uv.y += cam.giData.w;

                let aspect = cam.resFovFrame.x / cam.resFovFrame.y;
                let fovScale = tan(cam.resFovFrame.z * 0.5);
                let camModel = i32(cam.dof.w + 0.1);

                var rayOrigin: vec3<f32>;
                var dirToScreen: vec3<f32>;

                if (camModel == 1) {
                    // --- ORTHOGRAPHIC ---
                    let orthoScale = cam.giData.y; // Uses the dedicated Ortho Scale parameter
                    uv.x *= aspect * orthoScale;
                    uv.y *= orthoScale;
                    let baseOrigin = cam.pos.xyz + cam.right.xyz * uv.x + cam.up.xyz * uv.y;
                    rayOrigin = baseOrigin + cam.right.xyz * randDisk.x + cam.up.xyz * randDisk.y;
                    dirToScreen = normalize(cam.dir.xyz);
                } else if (camModel == 2) {
                    // --- FISHEYE ---
                    uv.x *= aspect;
                    let r = length(uv);
                    let theta = r * (cam.resFovFrame.z * 0.5); // FOV slider controls the crop angle
                    if (r > 0.0001) {
                        let phi = atan2(uv.y, uv.x);
                        dirToScreen = normalize(cam.dir.xyz * cos(theta) + (cam.right.xyz * cos(phi) + cam.up.xyz * sin(phi)) * sin(theta));
                    } else {
                        dirToScreen = normalize(cam.dir.xyz);
                    }
                    let focalPoint = cam.pos.xyz + dirToScreen * cam.dof.y;
                    rayOrigin = cam.pos.xyz + cam.right.xyz * randDisk.x + cam.up.xyz * randDisk.y;
                    dirToScreen = normalize(focalPoint - rayOrigin);
                } else if (camModel == 3) {
                    // --- EQUIRECTANGULAR 360 (VR) ---
                    let lon = uv.x * 3.1415926535;
                    let lat = uv.y * 3.1415926535 * 0.5;
                    dirToScreen = normalize(cam.right.xyz * sin(lon)*cos(lat) + cam.up.xyz * sin(lat) + cam.dir.xyz * cos(lon)*cos(lat));
                    let focalPoint = cam.pos.xyz + dirToScreen * cam.dof.y;
                    rayOrigin = cam.pos.xyz + cam.right.xyz * randDisk.x + cam.up.xyz * randDisk.y;
                    dirToScreen = normalize(focalPoint - rayOrigin);
                } else if (camModel == 4) {
                    // --- TWO-POINT PERSPECTIVE ---
                    uv.x *= aspect * fovScale;
                    let flatDir = normalize(vec3<f32>(cam.dir.x, 0.00001, cam.dir.z));
                    let flatRight = normalize(cross(flatDir, vec3<f32>(0.0, 1.0, 0.0)));
                    let flatUp = vec3<f32>(0.0, 1.0, 0.0);
                    let pitch = asin(clamp(cam.dir.y, -0.999, 0.999));
                    let pitchOffset = tan(pitch) * fovScale;
                    uv.y = uv.y * fovScale + pitchOffset;

                    let unnormalizedDir = flatDir + flatRight * uv.x + flatUp * uv.y;
                    let focalPoint = cam.pos.xyz + unnormalizedDir * cam.dof.y;
                    rayOrigin = cam.pos.xyz + flatRight * randDisk.x + flatUp * randDisk.y;
                    dirToScreen = normalize(focalPoint - rayOrigin);
                } else {
                    // --- STANDARD PERSPECTIVE ---
                    uv.x *= aspect * fovScale;
                    uv.y *= fovScale;
                    let unnormalizedDir = cam.dir.xyz + cam.right.xyz * uv.x + cam.up.xyz * uv.y;
                    let focalPoint = cam.pos.xyz + unnormalizedDir * cam.dof.y;
                    rayOrigin = cam.pos.xyz + cam.right.xyz * randDisk.x + cam.up.xyz * randDisk.y;
                    dirToScreen = normalize(focalPoint - rayOrigin);
                }

                return Ray(rayOrigin, dirToScreen, 1.0 / dirToScreen);
            }
            
            fn getSkyColor(ray: Ray) -> vec3<f32> {
                let t = 0.5 * (normalize(ray.dir).y + 1.0);
                let baseSky = mix(vec3<f32>(0.05, 0.05, 0.05), cam.skyData.xyz, t);
                return baseSky * cam.skyData.w;
            }
        `;

            const shaders = {
                gbuffer: wgsl_common + `
                struct GBufferOutput {
    @location(0) pos: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) albedo: vec4<f32>,
    @location(3) motion: vec4<f32>, // changed to vec4
}

                @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
                    var pos = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
                    return vec4<f32>(pos[vi], 0.0, 1.0);
                }

                @fragment fn fs_main(@builtin(position) pos: vec4<f32>) -> GBufferOutput {
    var out: GBufferOutput;
    
    let frameCount = cam.resFovFrame.w;
    let rt_enabled = cam.counts.w; 
    let globalFrame = cam.extra.x;
    var rngState = (u32(pos.x) * 1973u + u32(pos.y) * 9277u + u32(globalFrame) * 26699u) | 1u;

    var jitter = vec2<f32>(0.0);
    var randDisk = vec2<f32>(0.0);
    if (rt_enabled > 0.5) {
        jitter = vec2<f32>(rand_float(&rngState) - 0.5, rand_float(&rngState) - 0.5);
        randDisk = rand_in_unit_disk(&rngState) * cam.dof.x;
    }

    let unjittered_uv = pos.xy / cam.resFovFrame.xy; 
    let ray = get_camera_ray(pos.xy, jitter, randDisk);
    let hit = worldHit(ray, &rngState);

    if (hit.hit) {
        out.pos = vec4<f32>(hit.point, hit.mat.trans);
        out.normal = vec4<f32>(hit.normal, hit.mat.smoothness);
        
        if (hit.mat.emStrength > 0.0) {
            out.albedo = vec4<f32>(hit.mat.emColor * hit.mat.emStrength, 1.0);
        } else {
            out.albedo = vec4<f32>(hit.mat.color, 0.0);
        }
        
        // Reproject for Motion Vectors
        var prev_world_pos = hit.point;
        if (hit.isSphere == 1u) {
            let s = spheres[hit.objId];
            prev_world_pos = hit.point + (s.prevPosRad.xyz - s.posRad.xyz);
        } else {
            let m = meshes[hit.objId];
            let local_pos = m.invModelMatrix * vec4<f32>(hit.point, 1.0);
            prev_world_pos = (m.prevModelMatrix * local_pos).xyz;
        }

        let toHit = prev_world_pos - cam.prevPos.xyz;
        let dist = dot(toHit, cam.prevDir.xyz);
        var motion_xy = vec2<f32>(0.0);
        
        let camModel = i32(cam.dof.w + 0.1);
        if (dist > 0.001 && (camModel == 0 || camModel == 4)) {
            let aspect = cam.resFovFrame.x / cam.resFovFrame.y; 
            let fovScale = tan(cam.resFovFrame.z * 0.5);
            let planeVec = toHit / dist;
            var prev_uv_scaled = vec2<f32>(dot(planeVec, cam.prevRight.xyz), dot(planeVec, cam.prevUp.xyz));
            if (camModel == 4) {
                let pitch = asin(clamp(cam.prevDir.y, -0.999, 0.999));
                prev_uv_scaled.y -= tan(pitch);
            }
            prev_uv_scaled.x /= (aspect * fovScale);
            prev_uv_scaled.y /= fovScale;
            prev_uv_scaled.y = -prev_uv_scaled.y;
            motion_xy = unjittered_uv - (prev_uv_scaled * 0.5 + 0.5);
        }
        
        // STORE METALLIC IN Z
        out.motion = vec4<f32>(motion_xy.x, motion_xy.y, hit.mat.metallic, 0.0);

    } else {
        out.pos = vec4<f32>(0.0);
        out.normal = vec4<f32>(0.0);
        out.albedo = vec4<f32>(getSkyColor(ray), -1.0); 
        out.motion = vec4<f32>(0.0);
    }
    
    return out;
}
            `,

                raytracerReSTIR: wgsl_common + `
                @group(1) @binding(0) var prevTex: texture_2d<f32>;
                @group(1) @binding(1) var gbPos: texture_2d<f32>;
                @group(1) @binding(2) var gbNormal: texture_2d<f32>;
                @group(1) @binding(3) var gbAlbedo: texture_2d<f32>;
                @group(1) @binding(4) var gbMotion: texture_2d<f32>;
                @group(1) @binding(5) var<storage, read_write> resCurr: array<Reservoir>;
                @group(1) @binding(6) var<storage, read> resPrev: array<Reservoir>;

                fn trace_bounces(initial_ray: Ray, rngState: ptr<function, u32>) -> vec3<f32> {
    var ray = initial_ray; 
    var rayColor = vec3<f32>(1.0); 
    var incomingLight = vec3<f32>(0.0);
    let max_bounces = i32(cam.dof.z);

    for (var bounce = 0; bounce < max_bounces; bounce++) {
        let hit = worldHit(ray, rngState);
        if (!hit.hit) { 
            incomingLight += rayColor * getSkyColor(ray); 
            break; 
        }

        incomingLight += rayColor * (hit.mat.emColor * hit.mat.emStrength);

        let isInside = dot(ray.dir, hit.normal) > 0.0;
        var outwardNormal = hit.normal; 
        var eta = 1.0 / hit.mat.ior;
        if (isInside) { outwardNormal = -hit.normal; eta = hit.mat.ior; }

        if (rand_float(rngState) < hit.mat.trans) {
            let cos_theta = min(dot(-ray.dir, outwardNormal), 1.0);
            let sin_theta = sqrt(max(0.0, 1.0 - cos_theta * cos_theta));
            if (eta * sin_theta > 1.0 || rand_float(rngState) < 0.1) {
                ray.dir = normalize(reflect(ray.dir, outwardNormal) + rand_unit_vector(rngState) * (1.0 - hit.mat.smoothness));
            } else {
                ray.dir = normalize(refract(normalize(ray.dir), outwardNormal, eta) + rand_unit_vector(rngState) * (1.0 - hit.mat.smoothness));
                rayColor *= hit.mat.color;
            }
            ray.origin = hit.point + ray.dir * 0.002;
            ray.invDir = 1.0 / ray.dir;
            continue;
        }

        // Clean, stylized bounce
        if (rand_float(rngState) < hit.mat.smoothness) {
            let fuzz = 1.0 - hit.mat.smoothness;
            let specularDir = reflect(ray.dir, outwardNormal);
            ray.dir = normalize(specularDir + rand_unit_vector(rngState) * fuzz);
            rayColor *= mix(vec3<f32>(1.0), hit.mat.color, hit.mat.metallic);
        } else {
            ray.dir = normalize(outwardNormal + rand_unit_vector(rngState));
            rayColor *= hit.mat.color;
        }

        ray.origin = hit.point + outwardNormal * 0.001;
        ray.invDir = 1.0 / ray.dir;

        if (max(rayColor.r, max(rayColor.g, rayColor.b)) < 0.01) { break; }
    }
    return incomingLight;
}

                @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
                    var pos = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
                    return vec4<f32>(pos[vi], 0.0, 1.0);
                }

               @fragment fn fs_main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let frameCount = cam.resFovFrame.w; 
    let samples = u32(cam.counts.z); 
    let rt_enabled = cam.counts.w;
    let coord = vec2<i32>(pos.xy);
    
    // --- RNG SEED FIX FOR OFFLINE RENDERING ---
    let globalFrame = cam.extra.x; 
    var rngState = (u32(pos.x) * 1973u + u32(pos.y) * 9277u + u32(globalFrame) * 26699u) | 1u;

    var jitter = vec2<f32>(0.0);
    var randDisk = vec2<f32>(0.0);
    if (rt_enabled > 0.5) {
        jitter = vec2<f32>(rand_float(&rngState) - 0.5, rand_float(&rngState) - 0.5);
        randDisk = rand_in_unit_disk(&rngState) * cam.dof.x;
    }
    let cameraRay = get_camera_ray(pos.xy, jitter, randDisk);
    let dirToScreen = cameraRay.dir;
    let V = -dirToScreen;

    let gb_p = textureLoad(gbPos, coord, 0);
    let gb_n = textureLoad(gbNormal, coord, 0);
    let gb_a = textureLoad(gbAlbedo, coord, 0);
    
    // EXTRACT METALLIC FROM G-BUFFER
    let gb_m_full = textureLoad(gbMotion, coord, 0);
    let gb_m = gb_m_full.xy;
    let metallic = gb_m_full.z;

    if (rt_enabled < 0.5) {
        if (gb_a.a < -0.5) {
            let ray = Ray(cameraRay.origin, dirToScreen, 1.0 / dirToScreen);
            return vec4<f32>(getSkyColor(ray), 1.0);
        } else {
            let N = normalize(gb_n.xyz);
            let L1 = normalize(vec3<f32>(0.5, 1.0, -0.5)); let NdotL1 = max(dot(N, L1), 0.0);
            let L2 = normalize(vec3<f32>(-0.8, -0.2, 0.5)); let NdotL2 = max(dot(N, L2), 0.0);
            let skyWeight = 0.5 * (N.y + 1.0);
            let ambient = mix(vec3<f32>(0.05), cam.skyData.xyz * cam.skyData.w, skyWeight) * 0.5;
            let H1 = normalize(L1 + V); let spec1 = pow(max(dot(N, H1), 0.0), 64.0) * gb_n.w * 1.5;
            let H2 = normalize(L2 + V); let spec2 = pow(max(dot(N, H2), 0.0), 32.0) * gb_n.w * 0.5;
            
            let fresnel = 1.0 - max(dot(N, V), 0.0); let edgeDarken = mix(1.0, 0.6, fresnel * gb_n.w);
            var matColor = gb_a.rgb * edgeDarken * (NdotL1 * 1.5 + NdotL2 * 0.3 + ambient);
            
            // PREVIEW TINTED BY METALLIC
            matColor += mix(vec3<f32>(1.0), gb_a.rgb, metallic) * (spec1 + spec2);
            matColor += gb_a.rgb * max(0.0, gb_a.a);
            
            if (gb_p.w > 0.0) {
                let ray = Ray(gb_p.xyz - V * 0.001, -V, 1.0 / -V);
                matColor = mix(matColor, getSkyColor(ray), gb_p.w * 0.85);
            }
            return vec4<f32>(matColor, 1.0);
        }
    }

    var totalColor = vec3<f32>(0.0);
    let pixel_idx = u32(coord.y) * u32(cam.resFovFrame.x) + u32(coord.x);
    var r: Reservoir;
    r.y_point = vec4<f32>(0.0); r.y_normal = vec4<f32>(0.0); r.y_radiance = vec4<f32>(0.0, 0.0, 0.0, bitcast<f32>(0u));

    if (gb_a.a < -0.5) { 
        totalColor = getSkyColor(cameraRay);
    } else {
        let hitPoint = gb_p.xyz;
        let hitNormal = gb_n.xyz;
        let smoothness = gb_n.w;
        let albedo = gb_a.rgb;
        let trans = gb_p.w; 

        if (gb_a.a > 0.0) { totalColor += albedo; }

        if (rand_float(&rngState) < trans) {
            var bounceRay = Ray(hitPoint + dirToScreen * 0.001, dirToScreen, 1.0 / dirToScreen);
            totalColor += trace_bounces(bounceRay, &rngState);
        } else {
            var bounceRay = Ray(hitPoint + hitNormal * 0.002, vec3(0.0), vec3(0.0));
            var pdf = 1.0;

            if (rand_float(&rngState) < smoothness) {
                let fuzz = 1.0 - smoothness;
                bounceRay.dir = normalize(reflect(dirToScreen, hitNormal) + rand_unit_vector(&rngState) * fuzz);
                pdf = max(smoothness, 0.001); 
            } else {
                bounceRay.dir = normalize(hitNormal + rand_unit_vector(&rngState));
                pdf = max(1.0 - smoothness, 0.001); 
            }
            bounceRay.invDir = 1.0 / bounceRay.dir;

            var incomingLight = vec3<f32>(0.0);
            if (dot(bounceRay.dir, hitNormal) > 0.0) {
                incomingLight = trace_bounces(bounceRay, &rngState) * cam.giData.x;
            }

            // PASS METALLIC TO EVAL_CONTRIBUTION
            let contrib = eval_contribution(bounceRay.dir, incomingLight, hitNormal, albedo, smoothness, metallic, V);
            let p_hat = dot(contrib, vec3<f32>(0.2126, 0.7152, 0.0722));
            
            let weight = p_hat / pdf; 
            updateReservoir(&r, vec4<f32>(bounceRay.dir, 0.0), vec4<f32>(albedo, 0.0), incomingLight, weight, &rngState);

            if (frameCount > 0.0) {
                let unjittered_uv = pos.xy / cam.resFovFrame.xy;
                let prev_coord = vec2<i32>((unjittered_uv - gb_m) * cam.resFovFrame.xy);
                if (prev_coord.x >= 0 && prev_coord.x < i32(cam.resFovFrame.x) && prev_coord.y >= 0 && prev_coord.y < i32(cam.resFovFrame.y)) {
                    var prev_r = resPrev[u32(prev_coord.y) * u32(cam.resFovFrame.x) + u32(prev_coord.x)];
                    prev_r.y_radiance.w = bitcast<f32>(min(bitcast<u32>(prev_r.y_radiance.w), 15u));
                    let temp_contrib = eval_contribution(prev_r.y_point.xyz, prev_r.y_radiance.xyz, hitNormal, albedo, smoothness, metallic, V);
                    mergeReservoir(&r, prev_r, dot(temp_contrib, vec3<f32>(0.2126, 0.7152, 0.0722)), &rngState);
                }
            }

            // --- GHOSTING FIX: spatial reuse only allowed if frameCount > 0.0 ---
            if (frameCount > 0.0) {
                for (var i = 0; i < i32(samples); i++) { 
                    let neighbor_coord = coord + vec2<i32>(rand_in_unit_disk(&rngState) * 12.0);
                    if (neighbor_coord.x >= 0 && neighbor_coord.x < i32(cam.resFovFrame.x) && neighbor_coord.y >= 0 && neighbor_coord.y < i32(cam.resFovFrame.y)) {
                        let n_p = textureLoad(gbPos, neighbor_coord, 0).xyz;
                        let n_n = textureLoad(gbNormal, neighbor_coord, 0).xyz;
                        var n_r = resPrev[u32(neighbor_coord.y) * u32(cam.resFovFrame.x) + u32(neighbor_coord.x)];
                        
                        if (dot(n_n, hitNormal) > 0.9 && distance(n_p, hitPoint) < 0.2) {
                            n_r.y_radiance.w = bitcast<f32>(min(bitcast<u32>(n_r.y_radiance.w), 4u)); 
                            let spat_contrib = eval_contribution(n_r.y_point.xyz, n_r.y_radiance.xyz, hitNormal, albedo, smoothness, metallic, V);
                            mergeReservoir(&r, n_r, dot(spat_contrib, vec3<f32>(0.2126, 0.7152, 0.0722)), &rngState);
                        }
                    }
                }
            }

            let final_contrib = eval_contribution(r.y_point.xyz, r.y_radiance.xyz, hitNormal, albedo, smoothness, metallic, V);
            computeW(&r, dot(final_contrib, vec3<f32>(0.2126, 0.7152, 0.0722)));
            
            resCurr[pixel_idx] = r;
            totalColor += min(final_contrib * r.y_normal.w, vec3<f32>(50.0));
        }
    }
    
    var finalColor = totalColor;
    if (frameCount > 0.0) {
        let prevColor = textureLoad(prevTex, coord, 0).rgb;
        finalColor = mix(prevColor, totalColor, 1.0 / min(frameCount + 1.0, 2000.0));
    }
    return vec4<f32>(finalColor, 1.0);
}
            `,

                raytracerClassic: wgsl_common + `
                @group(1) @binding(0) var prevTex: texture_2d<f32>;
                // Include bindings so PipelineLayout identically matches ReSTIR's requirements
                @group(1) @binding(1) var gbPos: texture_2d<f32>;
                @group(1) @binding(2) var gbNormal: texture_2d<f32>;
                @group(1) @binding(3) var gbAlbedo: texture_2d<f32>;
                @group(1) @binding(4) var gbMotion: texture_2d<f32>;
                @group(1) @binding(5) var<storage, read_write> resCurr: array<Reservoir>;
                @group(1) @binding(6) var<storage, read> resPrev: array<Reservoir>;

                fn trace_classic(initial_ray: Ray, rngState: ptr<function, u32>) -> vec3<f32> {
    var ray = initial_ray; 
    var rayColor = vec3<f32>(1.0); 
    var incomingLight = vec3<f32>(0.0);
    let max_bounces = i32(cam.dof.z);

    for (var bounce = 0; bounce < max_bounces; bounce++) {
        let hit = worldHit(ray, rngState);
        let gi_mult = select(cam.giData.x, 1.0, bounce == 0);

        if (!hit.hit) { 
            incomingLight += rayColor * getSkyColor(ray) * gi_mult; 
            break; 
        }

        incomingLight += rayColor * (hit.mat.emColor * hit.mat.emStrength) * gi_mult;

        let isInside = dot(ray.dir, hit.normal) > 0.0;
        var outwardNormal = hit.normal; 
        var eta = 1.0 / hit.mat.ior;
        if (isInside) { outwardNormal = -hit.normal; eta = hit.mat.ior; }

        // Fast Transparency
        if (rand_float(rngState) < hit.mat.trans) {
            let cos_theta = min(dot(-ray.dir, outwardNormal), 1.0);
            let sin_theta = sqrt(max(0.0, 1.0 - cos_theta * cos_theta));
            if (eta * sin_theta > 1.0 || rand_float(rngState) < 0.1) { // Simple fake Fresnel
                ray.dir = normalize(reflect(ray.dir, outwardNormal) + rand_unit_vector(rngState) * (1.0 - hit.mat.smoothness));
            } else {
                ray.dir = normalize(refract(normalize(ray.dir), outwardNormal, eta) + rand_unit_vector(rngState) * (1.0 - hit.mat.smoothness));
                rayColor *= hit.mat.color;
            }
            ray.origin = hit.point + ray.dir * 0.002;
            ray.invDir = 1.0 / ray.dir;
            continue;
        }

        // Fast, Clean Opaque Scattering
        if (rand_float(rngState) < hit.mat.smoothness) {
            // Stylized Specular (The look you liked)
            let fuzz = 1.0 - hit.mat.smoothness;
            let specularDir = reflect(ray.dir, outwardNormal);
            ray.dir = normalize(specularDir + rand_unit_vector(rngState) * fuzz);
            rayColor *= mix(vec3<f32>(1.0), hit.mat.color, hit.mat.metallic);
        } else {
            // Clean Diffuse
            ray.dir = normalize(outwardNormal + rand_unit_vector(rngState));
            rayColor *= hit.mat.color;
        }

        ray.origin = hit.point + outwardNormal * 0.001;
        ray.invDir = 1.0 / ray.dir;

        if (max(rayColor.r, max(rayColor.g, rayColor.b)) < 0.01) { break; }
    }
    return incomingLight;
}

                @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
                    var pos = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
                    return vec4<f32>(pos[vi], 0.0, 1.0);
                }

                @fragment fn fs_main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let frameCount = cam.resFovFrame.w; 
    let samples = u32(cam.counts.z); 
    let rt_enabled = cam.counts.w;
    let coord = vec2<i32>(pos.xy);
    let globalFrame = cam.extra.x;
    var rngState = (u32(pos.x) * 1973u + u32(pos.y) * 9277u + u32(globalFrame) * 26699u) | 1u;

    let cameraRay = get_camera_ray(pos.xy, vec2(0.0), vec2(0.0));
    let dirToScreen = cameraRay.dir;

    if (rt_enabled < 0.5) {
        let gb_p = textureLoad(gbPos, coord, 0);
        let gb_n = textureLoad(gbNormal, coord, 0);
        let gb_a = textureLoad(gbAlbedo, coord, 0);
        
        if (gb_a.a < -0.5) {
            let ray = Ray(cameraRay.origin, dirToScreen, 1.0 / dirToScreen);
            return vec4<f32>(getSkyColor(ray), 1.0);
        } else {
            let N = normalize(gb_n.xyz); let V = -dirToScreen;
            let L1 = normalize(vec3<f32>(0.5, 1.0, -0.5)); let NdotL1 = max(dot(N, L1), 0.0);
            let L2 = normalize(vec3<f32>(-0.8, -0.2, 0.5)); let NdotL2 = max(dot(N, L2), 0.0);
            
            let skyWeight = 0.5 * (N.y + 1.0);
            let ambient = mix(vec3<f32>(0.05), cam.skyData.xyz * cam.skyData.w, skyWeight) * 0.5;
            
            let H1 = normalize(L1 + V); let spec1 = pow(max(dot(N, H1), 0.0), 64.0) * gb_n.w * 1.5;
            let H2 = normalize(L2 + V); let spec2 = pow(max(dot(N, H2), 0.0), 32.0) * gb_n.w * 0.5;
            
            let fresnel = 1.0 - max(dot(N, V), 0.0); let edgeDarken = mix(1.0, 0.6, fresnel * gb_n.w);
            
            var matColor = gb_a.rgb * edgeDarken * (NdotL1 * 1.5 + NdotL2 * 0.3 + ambient);
            matColor += vec3<f32>(1.0) * (spec1 + spec2);
            matColor += gb_a.rgb * max(0.0, gb_a.a);
            
            if (gb_p.w > 0.0) {
                let ray = Ray(gb_p.xyz - V * 0.001, -V, 1.0 / -V);
                matColor = mix(matColor, getSkyColor(ray), gb_p.w * 0.85);
            }
            return vec4<f32>(matColor, 1.0);
        }
    }

    var totalColor = vec3<f32>(0.0);
    
    for(var s: u32 = 0u; s < samples; s++) {
        let jitter = vec2<f32>(rand_float(&rngState)-0.5, rand_float(&rngState)-0.5);
        let randDisk = rand_in_unit_disk(&rngState) * cam.dof.x;
        var ray = get_camera_ray(pos.xy, jitter, randDisk);

        let sColor = trace_classic(ray, &rngState);
        totalColor += min(sColor, vec3<f32>(50.0));
    }

    totalColor /= f32(samples);

    var finalColor = totalColor;
    if (frameCount > 0.0) {
        let prevColor = textureLoad(prevTex, coord, 0).rgb;
        let weight = 1.0 / min(frameCount + 1.0, 8000.0);
        finalColor = mix(prevColor, totalColor, weight);
    }
    return vec4<f32>(finalColor, 1.0);
}
            `,
                screen: `
                struct PostProc { params: vec4<f32> }
                @group(0) @binding(0) var tex: texture_2d<f32>;
                @group(0) @binding(1) var<uniform> postProc: PostProc;
                @group(0) @binding(2) var oidnTex: texture_2d<f32>;

                fn ACESFilm(x: vec3<f32>) -> vec3<f32> {
                    let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
                    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
                }

                @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
                    var pos = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
                    return vec4<f32>(pos[vi], 0.0, 1.0);
                }
                
                @fragment fn fs_main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let centerCoord = vec2<i32>(pos.xy);
    var color = textureLoad(tex, centerCoord, 0).rgb; // The raw, noisy physical image
    
    let denoiseMode = postProc.params.x; 
    let frameCount = postProc.params.y;
    let useOidnResult = postProc.params.z;

    if (useOidnResult > 0.5) {
        let aiColor = textureLoad(oidnTex, centerCoord, 0).rgb;
        
        // --- THE FIX: AI ANCHORING ---
        // Blend 85% Denoised image with 15% Raw physical image.
        // This physically stops the AI from flickering/wobbling frame-to-frame.
        color = mix(color, aiColor, 1.0); //pure aiColor

    } else if (denoiseMode == 1.0 && frameCount < 200.0) { 
        // Fast Spatial Filter
        let noiseLevel = clamp(1.0 - (frameCount / 200.0), 0.0, 1.0);
        let radius = i32(mix(0.0, 3.0, pow(noiseLevel, 0.5)));
        
        if (radius > 0) {
            var colorSum = vec3<f32>(0.0); var weightSum = 0.0;
            let sigmaSpace = f32(radius); 
            let sigmaColor = mix(0.02, 0.15, noiseLevel);
            
            let invSigmaSpace2 = 1.0 / (2.0 * sigmaSpace * sigmaSpace);
            let invSigmaColor2 = 1.0 / (2.0 * sigmaColor * sigmaColor + 0.0001);

            let centerComp = color / (1.0 + color);

            for (var x = -radius; x <= radius; x++) {
                for (var y = -radius; y <= radius; y++) {
                    let sampleColor = textureLoad(tex, centerCoord + vec2<i32>(x, y), 0).rgb;
                    let spaceDist2 = f32(x*x + y*y); 
                    let spaceW = exp(-spaceDist2 * invSigmaSpace2);
                    
                    let sampleComp = sampleColor / (1.0 + sampleColor);
                    
                    let colorDiff = centerComp - sampleComp;
                    let colorDist2 = dot(colorDiff, colorDiff);
                    
                    let colorW = exp(-colorDist2 * invSigmaColor2);
                    let w = spaceW * colorW; 
                    
                    colorSum += sampleColor * w; 
                    weightSum += w;
                }
            }
            color = colorSum / weightSum;
        }
    }
    
    color = ACESFilm(color); 
    return vec4<f32>(pow(color, vec3<f32>(1.0 / 2.2)), 1.0); 
}
            `,
                refitCompute: `
                struct MorphParams { t: f32, triOffset: u32, nodeOffset: u32, leafCount: u32 }
                struct Triangle { v0: vec4<f32>, v1: vec4<f32>, v2: vec4<f32>, n0: vec4<f32>, n1: vec4<f32>, n2: vec4<f32> }
                struct BVHNode { aabbMin: vec3<f32>, leftFirst: u32, aabbMax: vec3<f32>, triCount: u32, parentIdx: i32, isLeaf: u32, pad1: u32, pad2: u32 }

                @group(0) @binding(0) var<uniform> params: MorphParams;
                @group(0) @binding(1) var<storage, read> trisA: array<Triangle>;
                @group(0) @binding(2) var<storage, read> trisB: array<Triangle>;
                @group(0) @binding(3) var<storage, read> leafIndices: array<u32>;
                @group(0) @binding(4) var<storage, read_write> outTris: array<Triangle>;
                @group(0) @binding(5) var<storage, read_write> outNodes: array<BVHNode>;
                @group(0) @binding(6) var<storage, read_write> flags: array<atomic<u32>>;

                @compute @workgroup_size(64)
                fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
                    let id = global_id.x;
                    if (id >= params.leafCount) { return; }

                    let localLeafIdx = leafIndices[id]; let leafIdx = params.nodeOffset + localLeafIdx;
                    let leafNode = outNodes[leafIdx]; let triStart = leafNode.leftFirst; let triCount = leafNode.triCount;
                    var aabbMin = vec3<f32>(999999.0); var aabbMax = vec3<f32>(-999999.0);

                    for (var i = 0u; i < triCount; i++) {
                        let localTriIdx = (triStart - params.triOffset) + i; 
                        let outTriIdx = triStart + i;

                        let a = trisA[localTriIdx]; let b = trisB[localTriIdx]; var out: Triangle;
                        out.v0 = mix(a.v0, b.v0, params.t); out.v1 = mix(a.v1, b.v1, params.t); out.v2 = mix(a.v2, b.v2, params.t);
                        out.n0 = vec4<f32>(normalize(mix(a.n0.xyz, b.n0.xyz, params.t)), 0.0);
                        out.n1 = vec4<f32>(normalize(mix(a.n1.xyz, b.n1.xyz, params.t)), 0.0);
                        out.n2 = vec4<f32>(normalize(mix(a.n2.xyz, b.n2.xyz, params.t)), 0.0);

                        outTris[outTriIdx] = out;
                        aabbMin = min(aabbMin, min(out.v0.xyz, min(out.v1.xyz, out.v2.xyz)));
                        aabbMax = max(aabbMax, max(out.v0.xyz, max(out.v1.xyz, out.v2.xyz)));
                    }

                    outNodes[leafIdx].aabbMin = aabbMin; outNodes[leafIdx].aabbMax = aabbMax;

                    var currNodeIdx = leafIdx;
                    while (true) {
                        let parentIdxF = outNodes[currNodeIdx].parentIdx;
                        if (parentIdxF < 0) { break; } 
                        
                        let parentIdx = u32(parentIdxF); let localParentIdx = parentIdx - params.nodeOffset;
                        let old_val = atomicAdd(&flags[localParentIdx], 1u);
                        if (old_val == 0u) { break; } 

                        let pNode = outNodes[parentIdx]; let leftChildIdx = pNode.leftFirst; let rightChildIdx = pNode.pad1; // Updated for LBVH compatibility
                        let leftNode = outNodes[leftChildIdx]; let rightNode = outNodes[rightChildIdx];

                        outNodes[parentIdx].aabbMin = min(leftNode.aabbMin, rightNode.aabbMin);
                        outNodes[parentIdx].aabbMax = max(leftNode.aabbMax, rightNode.aabbMax);
                        currNodeIdx = parentIdx;
                    }
                }
            `,
                lbvh_compute: wgsl_common + `
                struct MortonElement {
                    code: u32,
                    primitiveIdx: u32,
                }
                
                struct SceneBounds {
                    bMin: vec4<f32>,
                    bMax: vec4<f32>,
                }
                
                struct BuildParams {
                    triOffset: u32,
                    triCount: u32,
                    pad1: u32,
                    pad2: u32,
                }

                @group(1) @binding(0) var<storage, read_write> mortonBuffer: array<MortonElement>;
                @group(1) @binding(1) var<uniform> sceneBounds: SceneBounds;
                @group(1) @binding(2) var<uniform> buildParams: BuildParams;

                // --- 1. MORTON ENCODER ---
                fn expandBits(v: u32) -> u32 {
                    var x = v & 0x000003ffu;
                    x = (x | (x << 16u)) & 0x030000ffu;
                    x = (x | (x <<  8u)) & 0x0300f00fu;
                    x = (x | (x <<  4u)) & 0x030c30c3u;
                    x = (x | (x <<  2u)) & 0x09249249u;
                    return x;
                }

                fn morton3D(p: vec3<f32>) -> u32 {
                    let xx = expandBits(u32(clamp(p.x, 0.0, 0.999) * 1024.0));
                    let yy = expandBits(u32(clamp(p.y, 0.0, 0.999) * 1024.0));
                    let zz = expandBits(u32(clamp(p.z, 0.0, 0.999) * 1024.0));
                    return (zz << 2u) | (yy << 1u) | xx;
                }

                @compute @workgroup_size(256)
                fn encode_morton(@builtin(global_invocation_id) id: vec3<u32>) {
                    let idx = id.x;
                    if (idx >= buildParams.triCount) { return; }

                    let globalTriIdx = buildParams.triOffset + idx;
                    let tri = triangles[globalTriIdx];
                    
                    let centroid = (tri.v0.xyz + tri.v1.xyz + tri.v2.xyz) / 3.0;
                    let extent = sceneBounds.bMax.xyz - sceneBounds.bMin.xyz;
                    let normalized = (centroid - sceneBounds.bMin.xyz) / max(extent, vec3<f32>(0.0001));
                    
                    var element: MortonElement;
                    element.code = morton3D(normalized);
                    element.primitiveIdx = globalTriIdx;
                    mortonBuffer[idx] = element;
                }

                // --- 2. BITONIC SORT ---
                struct SortParams { j: u32, k: u32, pad1: u32, pad2: u32 }
                @group(1) @binding(3) var<uniform> sortParams: SortParams;

                @compute @workgroup_size(256)
                fn bitonic_sort(@builtin(global_invocation_id) id: vec3<u32>) {
                    let i = id.x;
                    let j = sortParams.j;
                    let k = sortParams.k;
                    let ixj = i ^ j;
                    
                    if (ixj > i && ixj < buildParams.triCount && i < buildParams.triCount) {
                        let a = mortonBuffer[i];
                        let b = mortonBuffer[ixj];
                        let dir = (i & k) == 0u;
                        if ((a.code > b.code) == dir) {
                            mortonBuffer[i] = b;
                            mortonBuffer[ixj] = a;
                        }
                    }
                }

                // --- 3. BUILD RADIX TREE (Karras 2012) ---
                @group(1) @binding(4) var<storage, read_write> bvhNodesWrite: array<BVHNode>;
                
                fn common_prefix(i: i32, j: i32, num_leaves: i32) -> i32 {
                    if (j < 0 || j >= num_leaves) { return -1; }
                    let a = mortonBuffer[i].code;
                    let b = mortonBuffer[j].code;
                    if (a == b) { return i32(32 + countLeadingZeros(u32(i ^ j))); }
                    return i32(countLeadingZeros(a ^ b));
                }

                @compute @workgroup_size(256)
                fn build_tree(@builtin(global_invocation_id) id: vec3<u32>) {
                    let i = i32(id.x);
                    let num_leaves = i32(buildParams.triCount);
                    if (i >= num_leaves - 1) { return; } 

                    if (i == 0) { bvhNodesWrite[0].parentIdx = -1; } 

                    let dir_i = i32(sign(f32(common_prefix(i, i + 1, num_leaves) - common_prefix(i, i - 1, num_leaves))));
                    let min_lcp = common_prefix(i, i - dir_i, num_leaves);
                    
                    var lmax = 2;
                    while (common_prefix(i, i + lmax * dir_i, num_leaves) > min_lcp) { lmax *= 2; }
                    
                    var l = 0;
                    var t = lmax / 2;
                    while (t >= 1) {
                        if (common_prefix(i, i + (l + t) * dir_i, num_leaves) > min_lcp) { l += t; }
                        t /= 2;
                    }
                    let j = i + l * dir_i;
                    
                    let node_lcp = common_prefix(i, j, num_leaves);
                    var s = 0;
                    var div = 2;
                    var t_ceil = (l + div - 1) / div;
                    while (t_ceil >= 1) {
                        if (common_prefix(i, i + (s + t_ceil) * dir_i, num_leaves) > node_lcp) { s += t_ceil; }
                        div *= 2;
                        let old_t_ceil = t_ceil;
                        t_ceil = (l + div - 1) / div;
                        if (old_t_ceil == 1) { break; }
                    }
                    let split = i + s * dir_i;

                    var left = split;
                    var right = split + 1;
                    if (min(i, j) == split) { left += num_leaves - 1; }
                    if (max(i, j) == split + 1) { right += num_leaves - 1; }

                    let nodeIdx = u32(i);
                    bvhNodesWrite[nodeIdx].leftFirst = u32(left);
                    bvhNodesWrite[nodeIdx].pad1 = u32(right); // STORE RIGHT CHILD HERE
                    bvhNodesWrite[nodeIdx].triCount = 0u;
                    bvhNodesWrite[nodeIdx].isLeaf = 0u;
                    
                    bvhNodesWrite[left].parentIdx = i32(nodeIdx);
                    bvhNodesWrite[right].parentIdx = i32(nodeIdx);
                }

                // --- 4. BOTTOM-UP AABB REFIT ---
                @group(1) @binding(5) var<storage, read_write> atomicFlags: array<atomic<u32>>;

                @compute @workgroup_size(256)
                fn refit_aabbs(@builtin(global_invocation_id) id: vec3<u32>) {
                    let idx = id.x;
                    let num_leaves = buildParams.triCount;
                    if (idx >= num_leaves) { return; }

                    let leafIdx = num_leaves - 1u + idx;
                    let triIdx = mortonBuffer[idx].primitiveIdx;
                    let tri = triangles[triIdx];
                    
                    let minPos = min(min(tri.v0.xyz, tri.v1.xyz), tri.v2.xyz);
                    let maxPos = max(max(tri.v0.xyz, tri.v1.xyz), tri.v2.xyz);
                    
                    bvhNodesWrite[leafIdx].aabbMin = minPos;
                    bvhNodesWrite[leafIdx].aabbMax = maxPos;
                    bvhNodesWrite[leafIdx].leftFirst = triIdx; 
                    bvhNodesWrite[leafIdx].triCount = 1u;
                    bvhNodesWrite[leafIdx].isLeaf = 1u;

                    var curr = leafIdx;
                    while (curr != 0u) { 
                        let parent = u32(bvhNodesWrite[curr].parentIdx);
                        
                        let old_val = atomicAdd(&atomicFlags[parent], 1u);
                        if (old_val == 0u) { break; } 

                        let left = bvhNodesWrite[parent].leftFirst;
                        let right = bvhNodesWrite[parent].pad1;

                        bvhNodesWrite[parent].aabbMin = min(bvhNodesWrite[left].aabbMin, bvhNodesWrite[right].aabbMin);
                        bvhNodesWrite[parent].aabbMax = max(bvhNodesWrite[left].aabbMax, bvhNodesWrite[right].aabbMax);
                        
                        curr = parent;
                    }
                }
            `
            };

            // ==========================================
            // Camera Controller
            // ==========================================
            class CameraController {
                constructor(camera, canvas) {
                    this.camera = camera; this.canvas = canvas; this.keys = {};
                    this.pitch = Math.asin(camera.dir[1]); this.yaw = Math.atan2(camera.dir[0], camera.dir[2]);
                    this.lastDir = new Float32Array([camera.dir[0], camera.dir[1], camera.dir[2]]);

                    this.speed = 8.0; this.sensitivity = 0.003; this.locked = false;
                    this.rtEnabled = false; this.useDoF = true;
                    this.targetFocus = camera.focusDist; 
                    this.autoFocus = true;

                    window.addEventListener('keydown', e => this.keys[e.code] = true);
                    window.addEventListener('keyup', e => this.keys[e.code] = false);

                    canvas.addEventListener('click', () => { if (!window.isRenderingVideo) canvas.requestPointerLock(); });
                    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === canvas; });

                    document.addEventListener('mousemove', e => {
                        if (!this.locked || window.isRenderingVideo) return;
                        this.yaw -= e.movementX * this.sensitivity; this.pitch -= e.movementY * this.sensitivity;
                        const limit = Math.PI / 2 - 0.01; this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
                    });
                }
                update(dt, mobjects = []) {
                    if (window.isRenderingVideo) return false;
                    let moved = false;

                    let dirChangedExternally =
                        Math.abs(this.camera.dir[0] - this.lastDir[0]) > 0.0001 ||
                        Math.abs(this.camera.dir[1] - this.lastDir[1]) > 0.0001 ||
                        Math.abs(this.camera.dir[2] - this.lastDir[2]) > 0.0001;

                    if (dirChangedExternally) {
                        this.yaw = Math.atan2(this.camera.dir[0], this.camera.dir[2]);
                        this.pitch = Math.asin(this.camera.dir[1]);
                        moved = true;
                    }

                    let oldDirX = this.camera.dir[0], oldDirY = this.camera.dir[1], oldDirZ = this.camera.dir[2];

                    this.camera.dir[0] = Math.cos(this.pitch) * Math.sin(this.yaw);
                    this.camera.dir[1] = Math.sin(this.pitch);
                    this.camera.dir[2] = Math.cos(this.pitch) * Math.cos(this.yaw);

                    if (Math.abs(oldDirX - this.camera.dir[0]) > 0.001 || Math.abs(oldDirY - this.camera.dir[1]) > 0.001) moved = true;

                    this.lastDir[0] = this.camera.dir[0];
                    this.lastDir[1] = this.camera.dir[1];
                    this.lastDir[2] = this.camera.dir[2];

                    const upDir = Math3D.vec3(0, 1, 0);
                    this.camera.right = Math3D.normalize(Math3D.cross(this.camera.dir, upDir));
                    this.camera.up = Math3D.cross(this.camera.right, this.camera.dir);

                    let velocity = Math3D.vec3(0, 0, 0);
                    if (this.keys['KeyW']) velocity = Math3D.add(velocity, this.camera.dir);
                    if (this.keys['KeyS']) velocity = Math3D.sub(velocity, this.camera.dir);
                    if (this.keys['KeyA']) velocity = Math3D.sub(velocity, this.camera.right);
                    if (this.keys['KeyD']) velocity = Math3D.add(velocity, this.camera.right);
                    if (this.keys['Space']) velocity = Math3D.add(velocity, Math3D.vec3(0, 1, 0));
                    if (this.keys['ShiftLeft']) velocity = Math3D.sub(velocity, Math3D.vec3(0, 1, 0));

                    if (Math3D.length(velocity) > 0) {
                        velocity = Math3D.scale(Math3D.normalize(velocity), this.speed * dt);
                        this.camera.pos = Math3D.add(this.camera.pos, velocity); moved = true;
                    }

                    if (this.keys['KeyQ']) { this.camera.focusDist = Math.max(0.1, this.camera.focusDist - 10.0 * dt); moved = true; this.autoFocus = false; }
                    if (this.keys['KeyE']) { this.camera.focusDist += 10.0 * dt; moved = true; this.autoFocus = false; }

                    if (this.keys['KeyF'] && !this.fPressed) { this.autoFocus = !this.autoFocus; this.fPressed = true; } else if (!this.keys['KeyF']) { this.fPressed = false; }
                    if (this.keys['BracketLeft']) { this.camera.aperture = Math.max(0.0, this.camera.aperture - 0.1 * dt); moved = true; }
                    if (this.keys['BracketRight']) { this.camera.aperture += 0.1 * dt; moved = true; }
                    if (this.keys['Minus']) { this.camera.fov = Math.max(0.1, this.camera.fov - 0.5 * dt); moved = true; }
                    if (this.keys['Equal']) { this.camera.fov = Math.min(Math.PI - 0.1, this.camera.fov + 0.5 * dt); moved = true; }

                    if (this.autoFocus && mobjects) {
                        let origin = this.camera.pos;
                        let dir = this.camera.dir;
                        let closest = 999999;

                        for (let m of mobjects) {
                            if (!m.triangles && m.radius !== undefined) {
                                let oc = Math3D.sub(origin, m.position);
                                let dotOCDir = oc[0] * dir[0] + oc[1] * dir[1] + oc[2] * dir[2];
                                let c = (oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2]) - (m.radius * m.scale[0]) ** 2;
                                let disc = dotOCDir * dotOCDir - c;
                                if (disc > 0) {
                                    let t = -dotOCDir - Math.sqrt(disc);
                                    if (t > 0 && t < closest) closest = t;
                                }
                            }
                            else if (m.triangles && m.bvh && m.bvh.nodes.length) {
                                let invMat = Math3D.mat4();
                                Math3D.mat4Invert(invMat, m.get_world_matrix());

                                let lO = [
                                    invMat[0] * origin[0] + invMat[4] * origin[1] + invMat[8] * origin[2] + invMat[12],
                                    invMat[1] * origin[0] + invMat[5] * origin[1] + invMat[9] * origin[2] + invMat[13],
                                    invMat[2] * origin[0] + invMat[6] * origin[1] + invMat[10] * origin[2] + invMat[14]
                                ];
                                let lD = [
                                    invMat[0] * dir[0] + invMat[4] * dir[1] + invMat[8] * dir[2],
                                    invMat[1] * dir[0] + invMat[5] * dir[1] + invMat[9] * dir[2],
                                    invMat[2] * dir[0] + invMat[6] * dir[1] + invMat[10] * dir[2]
                                ];
                                let invLD = [1 / lD[0], 1 / lD[1], 1 / lD[2]];

                                let stack = [0];
                                while (stack.length > 0) {
                                    let nodeIdx = stack.pop();
                                    let node = m.bvh.nodes[nodeIdx];

                                    let t1 = (node.min[0] - lO[0]) * invLD[0], t2 = (node.max[0] - lO[0]) * invLD[0];
                                    let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2);
                                    let t3 = (node.min[1] - lO[1]) * invLD[1], t4 = (node.max[1] - lO[1]) * invLD[1];
                                    tmin = Math.max(tmin, Math.min(t3, t4)); tmax = Math.min(tmax, Math.max(t3, t4));
                                    let t5 = (node.min[2] - lO[2]) * invLD[2], t6 = (node.max[2] - lO[2]) * invLD[2];
                                    tmin = Math.max(tmin, Math.min(t5, t6)); tmax = Math.min(tmax, Math.max(t5, t6));

                                    if (tmax < Math.max(0, tmin) || tmin >= closest) continue;

                                    if (node.triCount > 0) {
                                        for (let i = 0; i < node.triCount; i++) {
                                            let tri = m.bvh.triangles[node.leftFirst + i];
                                            let e1 = [tri[1][0] - tri[0][0], tri[1][1] - tri[0][1], tri[1][2] - tri[0][2]];
                                            let e2 = [tri[2][0] - tri[0][0], tri[2][1] - tri[0][1], tri[2][2] - tri[0][2]];
                                            let h = Math3D.cross(lD, e2);
                                            let a = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
                                            if (a > -0.00001 && a < 0.00001) continue;

                                            let f = 1.0 / a;
                                            let s = [lO[0] - tri[0][0], lO[1] - tri[0][1], lO[2] - tri[0][2]];
                                            let u = f * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
                                            if (u < 0.0 || u > 1.0) continue;

                                            let q = Math3D.cross(s, e1);
                                            let v = f * (lD[0] * q[0] + lD[1] * q[1] + lD[2] * q[2]);
                                            if (v < 0.0 || u + v > 1.0) continue;

                                            let t = f * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]);
                                            let worldDist = t * Math3D.length(lD);
                                            if (worldDist > 0.001 && worldDist < closest) closest = worldDist;
                                        }
                                    } else {
                                        stack.push(node.leftFirst, node.leftFirst + 1);
                                    }
                                }
                            }
                        }

                        if (closest !== 999999) {
                            if (Math.abs(closest - this.targetFocus) > 0.5) this.targetFocus = closest;
                        } else {
                            if (Math.abs(10.0 - this.targetFocus) > 0.5) this.targetFocus = 10.0;
                        }

                        if (Math.abs(this.camera.focusDist - this.targetFocus) > 0.05) {
                            this.camera.focusDist += (this.targetFocus - this.camera.focusDist) * 5.0 * dt;
                            moved = true;
                        } else {
                            this.camera.focusDist = this.targetFocus;
                        }
                    }

                    if (this.keys['KeyR'] && !this.rPressed) {
                        let sel = document.getElementById('selPreviewDenoiser');
                        if (sel) {
                            sel.value = (parseInt(sel.value) + 1) % 4;
                            sel.dispatchEvent(new Event('change'));
                        }
                        this.rPressed = true; moved = true;
                    } else if (!this.keys['KeyR']) {
                        this.rPressed = false;
                    }

                    if (this.keys['KeyT'] && !this.tPressed) { document.getElementById('btnToggleRT').click(); this.tPressed = true; moved = true; } else if (!this.keys['KeyT']) { this.tPressed = false; }
                    if (this.keys['KeyB'] && !this.bPressed) { document.getElementById('btnToggleDoF').click(); this.bPressed = true; moved = true; } else if (!this.keys['KeyB']) { this.bPressed = false; }

                    return moved;
                }

            }


            // ==========================================
            // Render Engine
            // ==========================================
            class RenderEngine {
                constructor(canvas) {
                    this.canvas = canvas;
                    this.width = 1280; this.height = 720;
                    this.canvas.width = this.width; this.canvas.height = this.height;

                    this.camData = new Float32Array(56);

                    this.useScissor = false;
                    this.tileRect = null;
                    this.rtTechnique = 0; // Default to Classic
                }


                async init() {
                    if (!navigator.gpu) throw new Error("WebGPU not supported.");
                    this.adapter = await navigator.gpu.requestAdapter();

                    const requiredLimits = {
                        maxStorageBufferBindingSize: this.adapter.limits.maxStorageBufferBindingSize,
                        maxBufferSize: this.adapter.limits.maxBufferSize,
                        maxComputeWorkgroupStorageSize: this.adapter.limits.maxComputeWorkgroupStorageSize,
                    };
                    if (this.adapter.limits.maxColorAttachmentBytesPerSample > 32) {
                        requiredLimits.maxColorAttachmentBytesPerSample = this.adapter.limits.maxColorAttachmentBytesPerSample;
                    }

                    this.device = await this.adapter.requestDevice({ requiredLimits });
                    this.context = this.canvas.getContext('webgpu');
                    this.presentationFormat = navigator.gpu.getPreferredCanvasFormat();
                    this.context.configure({ device: this.device, format: this.presentationFormat });

                    this.setupCoreBuffers();
                    this.setupResolutionDependentBuffers();
                    this.msdfTexture = createSDFTexture(this.device);
                    this.setupPipelines();
                }
                setupCoreBuffers() {
                    this.linearSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });

                    const storageUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;

                    // Lightweight startup capacities! 
                    // Triangles: 50,000 * 96b = ~4.8 MB
                    // BVH Nodes: 100,000 * 48b = ~4.8 MB
                    this.sphereArena = new GPUArena(this.device, "Spheres", 1000, 80, storageUsage);
                    this.meshArena = new GPUArena(this.device, "Meshes", 1000, 288, storageUsage);
                    this.triangleArena = new GPUArena(this.device, "Triangles", 50000, 96, storageUsage);
                    this.bvhArena = new GPUArena(this.device, "BVHNodes", 100000, 48, storageUsage);

                    this.mortonArena = new GPUArena(this.device, "Morton", 50000, 8, storageUsage | GPUBufferUsage.COPY_SRC);
                    this.flagsArena = new GPUArena(this.device, "BVHFlags", 100000, 4, storageUsage);

                    // ... rest of the buffers
                    this.cameraBuffer = this.device.createBuffer({ size: 224, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
                    this.postProcBuffer = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
                    this.vectorTexture = this.device.createTexture({ size: [2048, 2048, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });

                    this.lbvhSceneBoundsBuffer = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
                    this.lbvhBuildParamsBuffer = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
                    this.lbvhSortParamsBuffer = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

                    this.MAX_TEXTURE_LAYERS = 64;
                    this.TEX_SIZE = 1024;

                    // ADDED RENDER_ATTACHMENT HERE
                    this.albedoTexArray = this.device.createTexture({
                        size: [this.TEX_SIZE, this.TEX_SIZE, this.MAX_TEXTURE_LAYERS],
                        format: 'rgba8unorm',
                        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
                    });

                    // ADDED RENDER_ATTACHMENT HERE
                    this.normalTexArray = this.device.createTexture({
                        size: [this.TEX_SIZE, this.TEX_SIZE, this.MAX_TEXTURE_LAYERS],
                        format: 'rgba8unorm',
                        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
                    });
                }


                async loadMeshesTextures(mobjects) {
                    const albedoUrls = [...new Set(mobjects.map(m => m.albedoUrl).filter(url => url))];
                    const normalUrls = [...new Set(mobjects.map(m => m.normalUrl).filter(url => url))];

                    const maxRequiredLayers = Math.max(albedoUrls.length, normalUrls.length, 1);

                    // Dynamically expand Texture Arrays if needed
                    if (maxRequiredLayers > this.MAX_TEXTURE_LAYERS) {
                        this.MAX_TEXTURE_LAYERS = Math.ceil(maxRequiredLayers * 1.5);
                        console.log(`[Arena] Expanding Texture Array Layers to ${this.MAX_TEXTURE_LAYERS}`);

                        if (this.albedoTexArray) this.albedoTexArray.destroy();
                        if (this.normalTexArray) this.normalTexArray.destroy();

                        // ADDED RENDER_ATTACHMENT HERE
                        this.albedoTexArray = this.device.createTexture({
                            size: [this.TEX_SIZE, this.TEX_SIZE, this.MAX_TEXTURE_LAYERS],
                            format: 'rgba8unorm',
                            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
                        });

                        // ADDED RENDER_ATTACHMENT HERE
                        this.normalTexArray = this.device.createTexture({
                            size: [this.TEX_SIZE, this.TEX_SIZE, this.MAX_TEXTURE_LAYERS],
                            format: 'rgba8unorm',
                            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
                        });

                        if (this.bgLayout0) this.updateBindGroups();
                    }


                    const uploadToLayer = async (urls, targetTexture) => {
                        for (let i = 0; i < urls.length; i++) {
                            try {
                                const response = await fetch(urls[i]);
                                const blob = await response.blob();
                                const imageBitmap = await createImageBitmap(blob, { resizeWidth: this.TEX_SIZE, resizeHeight: this.TEX_SIZE });

                                this.device.queue.copyExternalImageToTexture(
                                    { source: imageBitmap },
                                    { texture: targetTexture, origin: [0, 0, i] }, [this.TEX_SIZE, this.TEX_SIZE]
                                );
                            } catch (e) { console.warn("Failed to load texture:", urls[i], e); }
                        }
                    };

                    await Promise.all([
                        uploadToLayer(albedoUrls, this.albedoTexArray),
                        uploadToLayer(normalUrls, this.normalTexArray)
                    ]);

                    mobjects.forEach(m => {
                        if (m.triangles) {
                            m.albedoTexIdx = m.albedoUrl ? albedoUrls.indexOf(m.albedoUrl) : -1.0;
                            m.normalTexIdx = m.normalUrl ? normalUrls.indexOf(m.normalUrl) : -1.0;
                        }
                    });
                }


                setupResolutionDependentBuffers() {
                    const texDesc = { size: [this.width, this.height, 1], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING };
                    this.texA = this.device.createTexture(texDesc); this.texB = this.device.createTexture(texDesc);

                    this.readTexture = this.device.createTexture({ size: [this.width, this.height, 1], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
                    this.bytesPerRow = Math.ceil((this.width * 4) / 256) * 256;
                    this.readBuffer = this.device.createBuffer({ size: this.bytesPerRow * this.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

                    const gBufferUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
                    this.gBufferPos = this.device.createTexture({ size: [this.width, this.height, 1], format: 'rgba32float', usage: gBufferUsage });
                    this.gBufferNormal = this.device.createTexture({ size: [this.width, this.height, 1], format: 'rgba16float', usage: gBufferUsage });
                    this.gBufferAlbedo = this.device.createTexture({ size: [this.width, this.height, 1], format: 'rgba16float', usage: gBufferUsage });
                    this.gBufferMotion = this.device.createTexture({ size: [this.width, this.height, 1], format: 'rgba16float', usage: gBufferUsage });
                    const reservoirSize = this.width * this.height * 48;
                    this.reservoirA = this.device.createBuffer({ size: reservoirSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
                    this.reservoirB = this.device.createBuffer({ size: reservoirSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
                    this.reservoirSpatial = this.device.createBuffer({ size: reservoirSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

                    const numPixels = this.width * this.height;
                    this.oidnColorBuf = this.device.createBuffer({
                        size: numPixels * 16,
                        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
                    });
                    
                    // --- ADD THESE TWO BUFFERS ---
                    this.oidnAlbedoBuf = this.device.createBuffer({
                        size: numPixels * 16,
                        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
                    });
                    this.oidnNormalBuf = this.device.createBuffer({
                        size: numPixels * 16,
                        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
                    });

                    this.oidnReadBuf = this.device.createBuffer({ size: numPixels * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                    this.oidnTexture = this.device.createTexture({ size: [this.width, this.height, 1], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
                }

                resize(newWidth, newHeight) {
                    if (this.width === newWidth && this.height === newHeight) return;
                    this.width = newWidth; this.height = newHeight;
                    this.canvas.width = newWidth; this.canvas.height = newHeight;
                    this.setupResolutionDependentBuffers();
                    this.updateBindGroups();
                }

                setupPipelines() {
                    const rtModuleReSTIR = this.device.createShaderModule({ code: shaders.raytracerReSTIR });
                    const rtModuleClassic = this.device.createShaderModule({ code: shaders.raytracerClassic });
                    const screenModule = this.device.createShaderModule({ code: shaders.screen });
                    const refitModule = this.device.createShaderModule({ code: shaders.refitCompute });
                    const gBufferModule = this.device.createShaderModule({ code: shaders.gbuffer });
                    const lbvhModule = this.device.createShaderModule({ code: shaders.lbvh_compute });

                    const oidnExtractWgsl = `
                    @group(0) @binding(0) var texColor: texture_2d<f32>;
                    @group(0) @binding(1) var<storage, read_write> colorBuf: array<vec4<f32>>;
                    
                    @group(0) @binding(2) var texAlbedo: texture_2d<f32>;
                    @group(0) @binding(3) var<storage, read_write> albedoBuf: array<vec4<f32>>;
                    
                    @group(0) @binding(4) var texNormal: texture_2d<f32>;
                    @group(0) @binding(5) var<storage, read_write> normalBuf: array<vec4<f32>>;

                    @compute @workgroup_size(8, 8)
                    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
                        let dim = textureDimensions(texColor);
                        if (id.x >= dim.x || id.y >= dim.y) { return; }
                        
                        let coord = vec2<i32>(id.xy);
                        let idx = id.y * dim.x + id.x;
                        
                        // 1. Extract Color
                        colorBuf[idx] = textureLoad(texColor, coord, 0);
                        
                        // 2. Extract Albedo (Clamped to 1.0 to remove Emissive HDR values, which confuse OIDN)
                        let alb = textureLoad(texAlbedo, coord, 0).rgb;
                        albedoBuf[idx] = vec4<f32>(clamp(alb, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
                        
                        // 3. Extract Normal (Already in the [-1.0, 1.0] range required by OIDN)
                        let norm = textureLoad(texNormal, coord, 0).xyz;
                        normalBuf[idx] = vec4<f32>(norm, 1.0)*0.5 + 0.5;
                    }
                `;
                    const oidnInjectWgsl = `
                    @group(0) @binding(0) var<storage, read> inBuf: array<vec4<f32>>;
                    @group(0) @binding(1) var outTex: texture_storage_2d<rgba32float, write>;
                    @compute @workgroup_size(8, 8)
                    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
                        let dim = textureDimensions(outTex);
                        if (id.x >= dim.x || id.y >= dim.y) { return; }
                        textureStore(outTex, vec2<i32>(id.xy), inBuf[id.y * dim.x + id.x]);
                    }
                `;
                    this.oidnExtractModule = this.device.createShaderModule({ code: oidnExtractWgsl });
                    this.oidnExtractPipeline = this.device.createComputePipeline({ layout: 'auto', compute: { module: this.oidnExtractModule, entryPoint: 'main' } });
                    this.oidnInjectModule = this.device.createShaderModule({ code: oidnInjectWgsl });
                    this.oidnInjectPipeline = this.device.createComputePipeline({ layout: 'auto', compute: { module: this.oidnInjectModule, entryPoint: 'main' } });

                    this.bgLayout0 = this.device.createBindGroupLayout({
                        entries: [
                            { binding: 0, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                            { binding: 1, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                            { binding: 2, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                            { binding: 3, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                            { binding: 4, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                            { binding: 5, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
                            { binding: 6, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
                            { binding: 7, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
                            { binding: 8, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d-array' } },
                            { binding: 9, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d-array' } }
                        ]
                    });

                    this.bgLayout1 = this.device.createBindGroupLayout({
                        entries: [
                            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
                            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
                            { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
                            { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
                            { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
                            { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'storage' } },
                            { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }
                        ]
                    });

                    this.screenLayout = this.device.createBindGroupLayout({
                        entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }, { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }]
                    });

                    this.lbvhBgLayout = this.device.createBindGroupLayout({
                        entries: [
                            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }, { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }, { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                            { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }, { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
                        ]
                    });

                    this.gBufferPipeline = this.device.createRenderPipeline({
                        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bgLayout0] }),
                        vertex: { module: gBufferModule, entryPoint: 'vs_main' },
                        fragment: { module: gBufferModule, entryPoint: 'fs_main', targets: [{ format: 'rgba32float' }, { format: 'rgba16float' }, { format: 'rgba16float' }, { format: 'rgba16float' }] },
                        primitive: { topology: 'triangle-list' }
                    });

                    this.rtPipelineReSTIR = this.device.createRenderPipeline({
                        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bgLayout0, this.bgLayout1] }),
                        vertex: { module: rtModuleReSTIR, entryPoint: 'vs_main' }, fragment: { module: rtModuleReSTIR, entryPoint: 'fs_main', targets: [{ format: 'rgba32float' }] },
                        primitive: { topology: 'triangle-list' }
                    });

                    this.rtPipelineClassic = this.device.createRenderPipeline({
                        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bgLayout0, this.bgLayout1] }),
                        vertex: { module: rtModuleClassic, entryPoint: 'vs_main' }, fragment: { module: rtModuleClassic, entryPoint: 'fs_main', targets: [{ format: 'rgba32float' }] },
                        primitive: { topology: 'triangle-list' }
                    });

                    this.screenPipeline = this.device.createRenderPipeline({
                        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.screenLayout] }),
                        vertex: { module: screenModule, entryPoint: 'vs_main' }, fragment: { module: screenModule, entryPoint: 'fs_main', targets: [{ format: this.presentationFormat }] },
                        primitive: { topology: 'triangle-list' }
                    });

                    this.offlineScreenPipeline = this.device.createRenderPipeline({
                        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.screenLayout] }),
                        vertex: { module: screenModule, entryPoint: 'vs_main' }, fragment: { module: screenModule, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
                        primitive: { topology: 'triangle-list' }
                    });

                    this.refitPipeline = this.device.createComputePipeline({ layout: 'auto', compute: { module: refitModule, entryPoint: 'main' } });

                    const lbvhPipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bgLayout0, this.lbvhBgLayout] });
                    this.lbvhEncodePipeline = this.device.createComputePipeline({ layout: lbvhPipelineLayout, compute: { module: lbvhModule, entryPoint: 'encode_morton' } });
                    this.lbvhSortPipeline = this.device.createComputePipeline({ layout: lbvhPipelineLayout, compute: { module: lbvhModule, entryPoint: 'bitonic_sort' } });
                    this.lbvhBuildTreePipeline = this.device.createComputePipeline({ layout: lbvhPipelineLayout, compute: { module: lbvhModule, entryPoint: 'build_tree' } });
                    this.lbvhRefitPipeline = this.device.createComputePipeline({ layout: lbvhPipelineLayout, compute: { module: lbvhModule, entryPoint: 'refit_aabbs' } });

                    this.updateBindGroups();
                }
                updateBindGroups() {
                    this.bg0 = this.device.createBindGroup({
                        layout: this.bgLayout0,
                        entries: [
                            { binding: 0, resource: { buffer: this.cameraBuffer } },
                            { binding: 1, resource: { buffer: this.sphereArena.gpuBuffer } },
                            { binding: 2, resource: { buffer: this.meshArena.gpuBuffer } },
                            { binding: 3, resource: { buffer: this.triangleArena.gpuBuffer } },
                            { binding: 4, resource: { buffer: this.bvhArena.gpuBuffer } },
                            { binding: 5, resource: this.vectorTexture.createView() },
                            { binding: 6, resource: this.msdfTexture ? this.msdfTexture.createView() : this.vectorTexture.createView() },
                            { binding: 7, resource: this.linearSampler },
                            { binding: 8, resource: this.albedoTexArray.createView({ dimension: '2d-array' }) },
                            { binding: 9, resource: this.normalTexArray.createView({ dimension: '2d-array' }) }
                        ]
                    });

                    const createRTBindGroup = (historyTex, resCurr, resPrev) => {
                        return this.device.createBindGroup({
                            layout: this.bgLayout1,
                            entries: [
                                { binding: 0, resource: historyTex.createView() }, { binding: 1, resource: this.gBufferPos.createView() },
                                { binding: 2, resource: this.gBufferNormal.createView() }, { binding: 3, resource: this.gBufferAlbedo.createView() },
                                { binding: 4, resource: this.gBufferMotion.createView() }, { binding: 5, resource: { buffer: resCurr } }, { binding: 6, resource: { buffer: resPrev } }
                            ]
                        });
                    };

                    this.bg1A = createRTBindGroup(this.texA, this.reservoirB, this.reservoirA);
                    this.bg1B = createRTBindGroup(this.texB, this.reservoirA, this.reservoirB);

                    this.screenBgA = this.device.createBindGroup({ layout: this.screenLayout, entries: [{ binding: 0, resource: this.texA.createView() }, { binding: 1, resource: { buffer: this.postProcBuffer } }, { binding: 2, resource: this.oidnTexture.createView() }] });
                    this.screenBgB = this.device.createBindGroup({ layout: this.screenLayout, entries: [{ binding: 0, resource: this.texB.createView() }, { binding: 1, resource: { buffer: this.postProcBuffer } }, { binding: 2, resource: this.oidnTexture.createView() }] });

                    this.lbvhBindGroup = this.device.createBindGroup({
                        layout: this.lbvhBgLayout,
                        entries: [
                            { binding: 0, resource: { buffer: this.mortonArena.gpuBuffer } },
                            { binding: 1, resource: { buffer: this.lbvhSceneBoundsBuffer } },
                            { binding: 2, resource: { buffer: this.lbvhBuildParamsBuffer } },
                            { binding: 3, resource: { buffer: this.lbvhSortParamsBuffer } },
                            { binding: 4, resource: { buffer: this.bvhArena.gpuBuffer } },
                            { binding: 5, resource: { buffer: this.flagsArena.gpuBuffer } }
                        ]
                    });
                }
                serializeTris(tris, outDataF32, offsetFloats) {
                    let i = offsetFloats;
                    for (let t = 0; t < tris.length; t++) {
                        let tri = tris[t];
                        outDataF32[i++] = tri[0][0]; outDataF32[i++] = tri[0][1]; outDataF32[i++] = tri[0][2]; outDataF32[i++] = tri[6] ? tri[6][0] : 0;
                        outDataF32[i++] = tri[1][0]; outDataF32[i++] = tri[1][1]; outDataF32[i++] = tri[1][2]; outDataF32[i++] = tri[7] ? tri[7][0] : 0;
                        outDataF32[i++] = tri[2][0]; outDataF32[i++] = tri[2][1]; outDataF32[i++] = tri[2][2]; outDataF32[i++] = tri[8] ? tri[8][0] : 0;
                        outDataF32[i++] = tri[3][0]; outDataF32[i++] = tri[3][1]; outDataF32[i++] = tri[3][2]; outDataF32[i++] = tri[6] ? tri[6][1] : 0;
                        outDataF32[i++] = tri[4][0]; outDataF32[i++] = tri[4][1]; outDataF32[i++] = tri[4][2]; outDataF32[i++] = tri[7] ? tri[7][1] : 0;
                        outDataF32[i++] = tri[5][0]; outDataF32[i++] = tri[5][1]; outDataF32[i++] = tri[5][2]; outDataF32[i++] = tri[8] ? tri[8][1] : 0;
                    }
                }

                serializeNodes(nodes, triOffset, bvhRootOffset, outF32, outI32, outU32, offsetNodes) {
                    let i = offsetNodes * 12;
                    for (let n = 0; n < nodes.length; n++) {
                        let node = nodes[n];
                        let leftFirst = node.triCount > 0 ? (node.leftFirst + triOffset) : (node.leftFirst + bvhRootOffset);
                        let parentIdx = node.parent !== -1 ? (node.parent + bvhRootOffset) : -1;

                        outF32[i + 0] = node.min[0]; outF32[i + 1] = node.min[1]; outF32[i + 2] = node.min[2]; outU32[i + 3] = leftFirst;
                        outF32[i + 4] = node.max[0]; outF32[i + 5] = node.max[1]; outF32[i + 6] = node.max[2]; outU32[i + 7] = node.triCount;
                        outI32[i + 8] = parentIdx; outU32[i + 9] = node.triCount > 0 ? 1 : 0;
                        outU32[i + 10] = node.triCount > 0 ? 0 : leftFirst + 1;
                        i += 12;
                    }
                }
                bakeMeshes(mobjects, bvhMethod = this.bvhMethod || 'spatial') {
                    let totalTris = 0;
                    let totalNodes = 0;
                    const meshList = mobjects.filter(o => o.triangles);

                    // 1. Calculate capacity requirements
                    meshList.forEach(mesh => {
                        if (!mesh.bvh || mesh.bvhDirty) {
                            if (mesh.isMorphing) { mesh.buildMorphBVH(bvhMethod); }
                            else { mesh.bvh = buildMeshBVH(mesh.triangles, bvhMethod); }
                            mesh.bvhDirty = false;
                        }
                        totalTris += mesh.bvh.triangles.length;
                        totalNodes += mesh.bvh.nodes.length;
                    });

                    // 2. Expand Arenas if needed.
                    let rebind = false;
                    rebind |= this.triangleArena.ensureCapacity(totalTris);
                    rebind |= this.mortonArena.ensureCapacity(totalTris);
                    rebind |= this.bvhArena.ensureCapacity(totalNodes);
                    rebind |= this.flagsArena.ensureCapacity(totalNodes);

                    // ---> THE FIX: Cascade the memory refresh <---
                    if (rebind) {
                        // Update main engine bindings
                        if (this.bgLayout0) this.updateBindGroups();

                        // Force dynamic objects to rebuild their WebGPU BindGroups
                        // because the underlying Arena GPU buffer was destroyed and recreated.
                        mobjects.forEach(m => {
                            if (m.gpuSetupDone !== undefined) {
                                m.gpuSetupDone = false;
                            }
                        });
                    }

                    let triOffset = 0, nodeOffset = 0;

                    // 3. Serialize into the safe CPU Array views
                    meshList.forEach(mesh => {
                        mesh.triOffset = triOffset; mesh.bvhRootOffset = nodeOffset;
                        if (!mesh.localAABB) mesh.localAABB = mesh.bvh.nodes.length > 0 ? mesh.bvh.nodes[0].min.concat(mesh.bvh.nodes[0].max) : [0, 0, 0, 0, 0, 0];

                        this.serializeTris(mesh.bvh.triangles, this.triangleArena.f32, triOffset * 24);
                        this.serializeNodes(mesh.bvh.nodes, triOffset, nodeOffset, this.bvhArena.f32, this.bvhArena.i32, this.bvhArena.u32, nodeOffset);

                        // 4. Handle Morph/Compute Bindings Safely
                        if (mesh.isMorphing && !mesh.morphBuffersAllocated) {
                            mesh.bufTrisA = this.device.createBuffer({ size: mesh.activeTrisA.length * 96, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
                            mesh.bufTrisB = this.device.createBuffer({ size: mesh.activeTrisB.length * 96, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
                            mesh.bufLeafIndices = this.device.createBuffer({ size: mesh.leafIndices.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
                            mesh.bufFlags = this.device.createBuffer({ size: mesh.bvh.nodes.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
                            mesh.bufParams = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
                            mesh.bufParamsArray = new Uint32Array(4);
                            mesh.bufParamsF32 = new Float32Array(mesh.bufParamsArray.buffer);
                            mesh.morphBuffersAllocated = true;
                        }

                        // Notice how this checks !mesh.gpuSetupDone. Because we set it to false above 
                        // during a resize, this will safely execute and bind to the NEW Arena buffer.
                        if (mesh.isMorphing && !mesh.gpuSetupDone) {
                            let tmpA = new Float32Array(mesh.activeTrisA.length * 24); this.serializeTris(mesh.activeTrisA, tmpA, 0);
                            let tmpB = new Float32Array(mesh.activeTrisB.length * 24); this.serializeTris(mesh.activeTrisB, tmpB, 0);

                            this.device.queue.writeBuffer(mesh.bufTrisA, 0, tmpA);
                            this.device.queue.writeBuffer(mesh.bufTrisB, 0, tmpB);
                            this.device.queue.writeBuffer(mesh.bufLeafIndices, 0, new Uint32Array(mesh.leafIndices));

                            mesh.morphBindGroup = this.device.createBindGroup({
                                layout: this.refitPipeline.getBindGroupLayout(0),
                                entries: [
                                    { binding: 0, resource: { buffer: mesh.bufParams } },
                                    { binding: 1, resource: { buffer: mesh.bufTrisA } },
                                    { binding: 2, resource: { buffer: mesh.bufTrisB } },
                                    { binding: 3, resource: { buffer: mesh.bufLeafIndices } },
                                    { binding: 4, resource: { buffer: this.triangleArena.gpuBuffer } }, // Dynamically grabs the newest buffer
                                    { binding: 5, resource: { buffer: this.bvhArena.gpuBuffer } },      // Dynamically grabs the newest buffer
                                    { binding: 6, resource: { buffer: mesh.bufFlags } }
                                ]
                            });
                            mesh.gpuSetupDone = true;
                        }
                        triOffset += mesh.bvh.triangles.length; nodeOffset += mesh.bvh.nodes.length;
                    });

                    // 5. Zero-Copy Upload
                    this.triangleArena.upload(this.device.queue, triOffset);
                    this.bvhArena.upload(this.device.queue, nodeOffset);
                }
                update(mobjects, camera, frameCount, useDenoiser, rtEnabled, useDoF = true, tempSamples = 4, globalFrameOverride = null) {
                    const useLegacyMetal = document.getElementById('chkLegacyMetal') ? document.getElementById('chkLegacyMetal').checked : false;
                    const spheres = mobjects.filter(o => !o.triangles && o.radius !== undefined);
                    const meshes = mobjects.filter(o => o.triangles);

                    let rebind = false;
                    rebind |= this.sphereArena.ensureCapacity(spheres.length);
                    rebind |= this.meshArena.ensureCapacity(meshes.length);
                    if (rebind && this.bgLayout0) this.updateBindGroups();

                    if (frameCount === 0) {
                        this.camData.set(camera.pos, 36); this.camData.set(camera.dir, 40); this.camData.set(camera.up, 44); this.camData.set(camera.right, 48);
                    } else {
                        this.camData.set(this.camData.subarray(0, 4), 36); this.camData.set(this.camData.subarray(4, 8), 40);
                        this.camData.set(this.camData.subarray(8, 12), 44); this.camData.set(this.camData.subarray(12, 16), 48);
                    }

                    this.camData.set(camera.pos, 0); this.camData.set(camera.dir, 4); this.camData.set(camera.up, 8); this.camData.set(camera.right, 12);
                    this.camData.set([this.width, this.height, camera.fov, frameCount], 16);
                    this.camData.set([spheres.length, meshes.length, tempSamples, rtEnabled ? 1.0 : 0.0], 20);
                    this.camData.set([useDoF ? camera.aperture : 0.0, camera.focusDist, camera.bounces, camera.model || 0], 24);
                    this.camData.set([camera.skyColor[0], camera.skyColor[1], camera.skyColor[2], camera.skyIntensity], 28);
                    this.camData.set([camera.giMultiplier, camera.orthoScale, camera.lensShiftX, camera.lensShiftY], 32);

                    let globalFrame = globalFrameOverride !== null ? globalFrameOverride : frameCount;
                    this.camData.set([globalFrame, 0, 0, 0], 52); // Store the global seed

                    this.device.queue.writeBuffer(this.cameraBuffer, 0, this.camData);

                    if (spheres.length > 0) {
                        let sData = this.sphereArena.f32;
                        spheres.forEach((obj, i) => {
                            let wMat = obj.get_world_matrix(); if (!obj.prevPos) obj.prevPos = [wMat[12], wMat[13], wMat[14]];
                            let offset = i * 20;
                            sData.set([wMat[12], wMat[13], wMat[14], obj.radius * obj.scale[0]], offset);
                            sData.set([obj.prevPos[0], obj.prevPos[1], obj.prevPos[2], 0], offset + 4);
                            sData.set([obj.color[0], obj.color[1], obj.color[2], obj.smoothness], offset + 8);
                            sData.set([obj.emColor[0], obj.emColor[1], obj.emColor[2], obj.emStrength], offset + 12);
                            let finalMetallic = useLegacyMetal ? Math.max(0.0, (obj.smoothness - 0.5) * 2.0) : obj.metallic;
                            sData.set([obj.transparency, obj.ior, finalMetallic, obj.opacity], offset + 16);
                            obj.prevPos = [wMat[12], wMat[13], wMat[14]];
                        });
                        this.sphereArena.upload(this.device.queue, spheres.length);
                    }

                    if (meshes.length > 0) {
                        let mData = this.meshArena.f32;
                        meshes.forEach((obj, i) => {
                            let wMat = obj.get_world_matrix();
                            if (!obj.invMat) obj.invMat = Math3D.mat4(); if (!obj.prevMat) obj.prevMat = new Float32Array(wMat);
                            Math3D.mat4Invert(obj.invMat, wMat);

                            let offset = i * 72;
                            mData.set(obj.invMat, offset); mData.set(wMat, offset + 16); mData.set(obj.prevMat, offset + 32);

                            let aabb = obj.localAABB || [0, 0, 0, 0, 0, 0];
                            let worldAABB = computeWorldAABB([aabb[0], aabb[1], aabb[2]], [aabb[3], aabb[4], aabb[5]], wMat);

                            mData.set([worldAABB.min[0] - 0.01, worldAABB.min[1] - 0.01, worldAABB.min[2] - 0.01, obj.opacity], offset + 48);
                            mData.set([worldAABB.max[0] + 0.01, worldAABB.max[1] + 0.01, worldAABB.max[2] + 0.01, 0], offset + 52);
                            mData.set([obj.color[0], obj.color[1], obj.color[2], obj.smoothness], offset + 56);
                            mData.set([obj.emColor[0], obj.emColor[1], obj.emColor[2], obj.emStrength], offset + 60);

                            let finalMeshMetallic = useLegacyMetal ? Math.max(0.0, (obj.smoothness - 0.5) * 2.0) : obj.metallic;
                            let vecType = 0.0; if (obj.isVector) vecType = 1.0; else if (obj.isMSDF) vecType = 2.0; else if (obj.isImplicit) vecType = 3.0;
                            let packedZ = vecType + (obj.isSmooth ? 10.0 : 0.0);
                            mData.set([obj.transparency, obj.ior, packedZ, finalMeshMetallic], offset + 64);
                            mData.set([obj.bvhRootOffset, obj.triangles.length, obj.albedoTexIdx ?? -1.0, obj.normalTexIdx ?? -1.0], offset + 68);
                            obj.prevMat = new Float32Array(wMat);
                        });
                        this.meshArena.upload(this.device.queue, meshes.length);
                    }
                }
                async extractOIDN(frameCount) {
        let readTex = frameCount % 2 === 0 ? this.texA : this.texB;
        
        // Dynamically build the Bind Group with all 6 resources
        const extractBg = this.device.createBindGroup({
            layout: this.oidnExtractPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: readTex.createView() },
                { binding: 1, resource: { buffer: this.oidnColorBuf } },
                { binding: 2, resource: this.gBufferAlbedo.createView() },
                { binding: 3, resource: { buffer: this.oidnAlbedoBuf } },
                { binding: 4, resource: this.gBufferNormal.createView() },
                { binding: 5, resource: { buffer: this.oidnNormalBuf } }
            ]
        });

        const enc = this.device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(this.oidnExtractPipeline);
        pass.setBindGroup(0, extractBg);
        pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
        pass.end();

        this.device.queue.submit([enc.finish()]);
        await this.device.queue.onSubmittedWorkDone();

        // Return all 3 buffers so OIDNManager can route them
        return {
            color: this.oidnColorBuf,
            albedo: this.oidnAlbedoBuf,
            normal: this.oidnNormalBuf
        };
    }

                injectOIDN(denoisedGPUBuffer) {
                    const injectBg = this.device.createBindGroup({ layout: this.oidnInjectPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: denoisedGPUBuffer } }, { binding: 1, resource: this.oidnTexture.createView() }] });
                    const enc = this.device.createCommandEncoder();
                    const pass = enc.beginComputePass();
                    pass.setPipeline(this.oidnInjectPipeline); pass.setBindGroup(0, injectBg);
                    pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
                    pass.end();
                    this.device.queue.submit([enc.finish()]);
                }

                render(frameCount, isOffline = false, mobjects = [], skipMorph = false, skipScreen = false) {
                    const commandEncoder = this.device.createCommandEncoder();

                    let hasMorph = mobjects.some(m => m.isMorphing && m.gpuSetupDone);
                    if (hasMorph && !skipMorph) {
                        for (let m of mobjects) if (m.isMorphing && m.gpuSetupDone) commandEncoder.clearBuffer(m.bufFlags);
                        const computePass = commandEncoder.beginComputePass();
                        computePass.setPipeline(this.refitPipeline);
                        for (let m of mobjects) {
                            if (m.isMorphing && m.gpuSetupDone) {
                                m.bufParamsF32[0] = m.morphWeight; m.bufParamsArray[1] = m.triOffset; m.bufParamsArray[2] = m.bvhRootOffset; m.bufParamsArray[3] = m.leafIndices.length;
                                this.device.queue.writeBuffer(m.bufParams, 0, m.bufParamsArray);
                                computePass.setBindGroup(0, m.morphBindGroup); computePass.dispatchWorkgroups(Math.ceil(m.bufParamsArray[3] / 64));
                            }
                        }
                        computePass.end();
                    }

                    let readBG = frameCount % 2 === 0 ? this.bg1B : this.bg1A;
                    let writeTex = frameCount % 2 === 0 ? this.texA : this.texB;
                    let finalBG = frameCount % 2 === 0 ? this.screenBgA : this.screenBgB;

                    const gBufferPass = commandEncoder.beginRenderPass({
                        colorAttachments: [
                            { view: this.gBufferPos.createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' },
                            { view: this.gBufferNormal.createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' },
                            { view: this.gBufferAlbedo.createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' },
                            { view: this.gBufferMotion.createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }
                        ]
                    });
                    gBufferPass.setPipeline(this.gBufferPipeline);
                    gBufferPass.setBindGroup(0, this.bg0);
                    if (this.useScissor && this.tileRect) gBufferPass.setScissorRect(this.tileRect.x, this.tileRect.y, this.tileRect.width, this.tileRect.height);
                    gBufferPass.draw(3, 1, 0, 0);
                    gBufferPass.end();

                    const rtPass = commandEncoder.beginRenderPass({ colorAttachments: [{ view: writeTex.createView(), loadOp: 'load', storeOp: 'store' }] });
                    const rtPipelineToUse = this.rtTechnique === 0 ? this.rtPipelineClassic : this.rtPipelineReSTIR;
                    rtPass.setPipeline(rtPipelineToUse);
                    rtPass.setBindGroup(0, this.bg0);
                    rtPass.setBindGroup(1, readBG);
                    if (this.useScissor && this.tileRect) rtPass.setScissorRect(this.tileRect.x, this.tileRect.y, this.tileRect.width, this.tileRect.height);
                    rtPass.draw(3, 1, 0, 0);
                    rtPass.end();

                    if (!skipScreen) {
                        const targetView = isOffline ? this.readTexture.createView() : this.context.getCurrentTexture().createView();
                        const targetPipeline = isOffline ? this.offlineScreenPipeline : this.screenPipeline;
                        const screenPass = commandEncoder.beginRenderPass({ colorAttachments: [{ view: targetView, loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store' }] });
                        screenPass.setPipeline(targetPipeline); screenPass.setBindGroup(0, finalBG);
                        if (this.useScissor && this.tileRect) screenPass.setScissorRect(this.tileRect.x, this.tileRect.y, this.tileRect.width, this.tileRect.height);
                        screenPass.draw(3, 1, 0, 0); screenPass.end();
                        if (isOffline) commandEncoder.copyTextureToBuffer({ texture: this.readTexture }, { buffer: this.readBuffer, bytesPerRow: this.bytesPerRow }, [this.width, this.height, 1]);
                    }

                    this.device.queue.submit([commandEncoder.finish()]);
                }
            }


            // ==========================================
            // Manim-Like Animation System
            // ==========================================
            const rate_functions = {
                linear: t => t, smooth: t => t * t * (3 - 2 * t), easeIn: t => t * t, easeOut: t => t * (2 - t),
                easeOutBounce: t => {
                    const n1 = 7.5625, d1 = 2.75;
                    if (t < 1 / d1) return n1 * t * t;
                    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
                    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
                    return n1 * (t -= 2.625 / d1) * t + 0.984375;
                },
                easeOutElastic: t => t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1
            };

            class Animation {
                constructor(mobject, kwargs = {}) {
                    this.mobject = mobject;
                    this.run_time = kwargs.run_time !== undefined ? kwargs.run_time : 1.0;
                    this.rate_func = kwargs.rate_func || rate_functions.smooth;
                    this.t = 0; this.finished = false; this.introducer = false;
                }
                begin() { } update(alpha) { } finish() { this.update(1.0); }
            }

            class Create extends Animation {
                constructor(mobject, kwargs) { super(mobject, kwargs); this.introducer = true; }
                begin() { this.targetScale = [...this.mobject.scale]; this.mobject.scale = [0.0001, 0.0001, 0.0001]; }
                update(alpha) {
                    this.mobject.scale = [
                        this.targetScale[0] * alpha + 0.0001 * (1 - alpha), this.targetScale[1] * alpha + 0.0001 * (1 - alpha), this.targetScale[2] * alpha + 0.0001 * (1 - alpha)
                    ];
                }
            }

            class Write extends Animation {
                constructor(mobject, kwargs) { super(mobject, kwargs); this.introducer = true; }
                begin() { if (this.mobject.setReveal) this.mobject.setReveal(0); this.mobject.scale = [...this.mobject.scale]; }
                update(alpha) { if (this.mobject.setReveal) this.mobject.setReveal(alpha); }
            }

            class Uncreate extends Animation {
                begin() { this.startScale = [...this.mobject.scale]; }
                update(alpha) {
                    let inv = 1.0 - alpha;
                    this.mobject.scale = [this.startScale[0] * inv + 0.0001 * alpha, this.startScale[1] * inv + 0.0001 * alpha, this.startScale[2] * inv + 0.0001 * alpha];
                }
                finish() { super.finish(); if (this.scene) this.scene.remove(this.mobject); }
            }

            class FadeIn extends Animation { 
                constructor(mobject, kwargs) { super(mobject, kwargs); this.introducer = true; }
                begin() { this.mobject.opacity = 0.0; }
                update(alpha) { this.mobject.opacity = alpha; }
            }

            class FadeOut extends Animation { 
                begin() { this.startOpacity = this.mobject.opacity; }
                update(alpha) { this.mobject.opacity = this.startOpacity * (1.0 - alpha); }
                finish() { super.finish(); if(this.scene) this.scene.remove(this.mobject); }
            }

            class MorphAnim extends Animation { update(alpha) { if (this.mobject.setMorph) this.mobject.setMorph(alpha); } }

            class MethodAnimation extends Animation {
                constructor(mobject, targetState, kwargs) { super(mobject, kwargs); this.targetState = targetState; }
                begin() { this.startState = this.mobject.copyState(); }
                // Inside class MethodAnimation
                update(alpha) {
                    const lerp = (a, b, t) => a + (b - a) * t;
                    const lerpArr = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));

                    this.mobject.position = lerpArr(this.startState.position, this.targetState.position, alpha);
                    this.mobject.scale = lerpArr(this.startState.scale, this.targetState.scale, alpha);
                    this.mobject.color = lerpArr(this.startState.color, this.targetState.color, alpha);

                    // --- NEW QUATERNION ROTATION ---
                    let qStart = Math3D.quatFromEuler(this.startState.rotation);
                    let qEnd = Math3D.quatFromEuler(this.targetState.rotation);
                    let qCurrent = Math3D.quatSlerp(qStart, qEnd, alpha);
                    this.mobject.rotation = Math3D.eulerFromQuat(qCurrent);
                    // -------------------------------

                    this.mobject.emColor = lerpArr(this.startState.emColor, this.targetState.emColor, alpha);
                    this.mobject.smoothness = lerp(this.startState.smoothness, this.targetState.smoothness, alpha);
                    this.mobject.transparency = lerp(this.startState.transparency, this.targetState.transparency, alpha);
                    this.mobject.ior = lerp(this.startState.ior, this.targetState.ior, alpha);
                    this.mobject.emStrength = lerp(this.startState.emStrength, this.targetState.emStrength, alpha);
                    this.mobject.value = lerp(this.startState.value, this.targetState.value, alpha);
                }
            }

            class ReplacementTransform extends Animation {
                constructor(mobject, targetMobject, kwargs) { super(mobject, kwargs); this.targetMobject = targetMobject; }
                begin() {
                    this.startState = this.mobject.copyState(); this.targetState = this.targetMobject.copyState();
                    this.targetMobject.scale = [0.0001, 0.0001, 0.0001];
                }
                update(alpha) {
                    const lerp = (a, b, t) => a + (b - a) * t; const lerpArr = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
                    this.mobject.position = lerpArr(this.startState.position, this.targetState.position, alpha);
                    this.mobject.rotation = lerpArr(this.startState.rotation, this.targetState.rotation, alpha);
                    this.mobject.scale = lerpArr(this.startState.scale, this.targetState.scale, alpha);
                    this.mobject.color = lerpArr(this.startState.color, this.targetState.color, alpha);
                }
                finish() {
                    super.finish();
                    if (this.scene) {
                        this.scene.remove(this.mobject); this.targetMobject.applyState(this.targetState); this.scene.add(this.targetMobject);
                    }
                }
            }

            class Indicate extends Animation {
                begin() {
                    this.startScale = [...this.mobject.scale];
                    this.startEm = this.mobject.emStrength;
                }
                update(alpha) {
                    let bump = Math.sin(alpha * Math.PI);
                    this.mobject.scale = this.startScale.map(s => s * (1.0 + bump * 0.15));
                    this.mobject.emStrength = this.startEm + (bump * 8.0);
                }
                finish() { this.mobject.scale = [...this.startScale]; this.mobject.emStrength = this.startEm; }
            }

            class MoveCamera extends Animation {
                constructor(camera, targetProps, kwargs) {
                    super(null, kwargs);
                    this.camera = camera;
                    this.targetProps = targetProps;
                }
                begin() {
                    this.startProps = {
                        pos: [...this.camera.pos], dir: [...this.camera.dir], focusDist: this.camera.focusDist, aperture: this.camera.aperture, fov: this.camera.fov
                    };
                }
                update(alpha) {
                    const lerp = (a, b, t) => a + (b - a) * t; const lerpArr = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
                    if (this.targetProps.pos) this.camera.pos = lerpArr(this.startProps.pos, this.targetProps.pos, alpha);
                    if (this.targetProps.dir) this.camera.dir = Math3D.normalize(lerpArr(this.startProps.dir, this.targetProps.dir, alpha));
                    if (this.targetProps.focusDist !== undefined) this.camera.focusDist = lerp(this.startProps.focusDist, this.targetProps.focusDist, alpha);
                    if (this.targetProps.aperture !== undefined) this.camera.aperture = lerp(this.startProps.aperture, this.targetProps.aperture, alpha);
                    if (this.targetProps.fov !== undefined) this.camera.fov = lerp(this.startProps.fov, this.targetProps.fov, alpha);

                    const upDir = Math3D.vec3(0, 1, 0);
                    this.camera.right = Math3D.normalize(Math3D.cross(this.camera.dir, upDir));
                    this.camera.up = Math3D.cross(this.camera.right, this.camera.dir);
                }
            }

            class TransformMatchingShapes extends Animation {
                constructor(groupA, groupB, kwargs) {
                    super(null, kwargs);
                    this.arrA = groupA.children ? groupA.children : groupA;
                    this.arrB = groupB.children ? groupB.children : groupB;
                    this.transforms = [];
                }
                begin() {
                    const count = Math.max(this.arrA.length, this.arrB.length);
                    for (let i = 0; i < count; i++) {
                        let a = this.arrA[i % this.arrA.length]; let b = this.arrB[i % this.arrB.length];
                        let t = new ReplacementTransform(a, b, { run_time: this.run_time });
                        t.scene = this.scene; t.begin();
                        this.transforms.push(t);
                    }
                }
                update(alpha) { this.transforms.forEach(t => t.update(alpha)); }
                finish() { this.transforms.forEach(t => t.finish()); }
            }

            class _AnimateWrapper {
                constructor(mobject, kwargs = {}) {
                    this.mobject = mobject; this.kwargs = kwargs; this.targetState = mobject.copyState();
                }
                shift(dx, dy, dz) { this.targetState.position[0] += dx; this.targetState.position[1] += dy; this.targetState.position[2] += dz; return this; }
                move_to(x, y, z) { this.targetState.position = [x, y, z]; return this; }
                scale_by(s) { this.targetState.scale[0] *= s; this.targetState.scale[1] *= s; this.targetState.scale[2] *= s; return this; }
                rotate(x, y, z) { this.targetState.rotation[0] += x; this.targetState.rotation[1] += y; this.targetState.rotation[2] += z; return this; }
                set_color(color) { this.targetState.color = color; return this; }
                set_material(color, smoothness, trans = 0.0, ior = 1.5, emColor = [0, 0, 0], emStrength = 0) {
                    this.targetState.color = color; this.targetState.smoothness = smoothness; this.targetState.transparency = trans; this.targetState.ior = ior;
                    this.targetState.emColor = emColor; this.targetState.emStrength = emStrength; return this;
                }
                set_value(v) { this.targetState.value = v; return this; }
                build() { return new MethodAnimation(this.mobject, this.targetState, this.kwargs); }
            }

            var N = 1;
            


            // ==========================================
            // Scene API & Architecture
            // ==========================================

            class Material {
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
        return new Material({ color: [0,0,0], emColor: color, emStrength: strength });
    }

    // This forces IOR to 1.0, which disables refraction so light travels perfectly straight!
    static TransparentNoRefraction(color = [0.4, 0.7, 1.0], transparency = 0.8) {
        return new Material({ color, smoothness: 1.0, transparency: transparency, ior: 1.0, metallic: 0.0 ,});
    }
}
            class Mobject {
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
    
    animate(kwargs) { return new _AnimateWrapper(this, kwargs); }
}

class ValueTracker extends Mobject { constructor(val = 0) { super(); this.value = val; } get_value() { return this.value; } }

class Group extends Mobject {
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

            class MeshObject extends Mobject {
                constructor(tris, isSmooth = true) {
                    super();
                    this.triangles = tris;
                    this.isSmooth = isSmooth;
                }
            }


            class TaichiWater extends MeshObject {
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



            class NativeGPUWater extends MeshObject {
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
            class ParametricSurface extends MeshObject {
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

            class RaytracedPath extends MeshObject {
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
            class VectorAtlas {
                constructor(width = 2048 * N, height = 2048 * N) {
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
            const globalVectorAtlas = new VectorAtlas();

            class VectorObject extends MeshObject {
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

            class TextObject extends VectorObject {
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

            class SVGObject extends VectorObject {
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

            class MathTex extends SVGObject {
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

            class ImageObject extends VectorObject {
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

            class VideoObject extends VectorObject {
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
            class MSDFObject extends MeshObject {
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

            class ImplicitCurveObject extends MeshObject {
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

            class Sphere extends Mobject { constructor(radius = 1.0) { super(); this.radius = radius; } }
            class MorphMeshObject extends Mobject {
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
            class Scene {
                constructor() {
                    this.mobjects = [];
                    this.activeAnimations = [];
                    const p = Math3D.vec3(0, 3, 10); const target = Math3D.vec3(0, 1.5, 0);
                    const dir = Math3D.normalize(Math3D.sub(target, p));
                    const right = Math3D.normalize(Math3D.cross(dir, Math3D.vec3(0, 1, 0)));

                    this.camera = {
                        pos: p, dir: dir, right: right, up: Math3D.cross(right, dir),
                        fov: Math.PI / 4, aperture: 0.10, focusDist: Math3D.length(Math3D.sub(target, p)),
                        samplesPerFrame: 1, bounces: 5, model: 0,
                        skyColor: [0.1, 0.2, 0.35], skyIntensity: 1.0, giMultiplier: 1.0,
                        orthoScale: 10.0, lensShiftX: 0.0, lensShiftY: 0.0 // <-- Added properties
                    };

                    this.lastTime = performance.now();
                    this.frameCount = 0;
                    this.clock = 0;
                    window.isRenderingVideo = false;

                    this.isPlaying = true;
                    this.isLooping = false;
                    this.loopStart = 0.0;
                    this.loopEnd = 15.0;
                    this.playbackSpeed = 1.0;
                }

                async play(...animations) {
                    animations = animations.map(a => a.build ? a.build() : a);
                    animations.forEach(a => {
                        a.scene = this;
                        if (a.introducer && !this.mobjects.includes(a.mobject)) this.add(a.mobject);
                        a.begin();
                    });
                    return new Promise(resolve => this.activeAnimations.push({ animations, resolve }));
                }

                async wait(duration = 1.0) {
                    return new Promise(resolve => this.activeAnimations.push({ timer: 0, duration, resolve, isWait: true }));
                }

                add(...objs) {
                    let needsBake = false;
                    const addRecursive = (o) => {
                        if (!this.mobjects.includes(o)) { 
                            this.mobjects.push(o); 
                            if (o.triangles) needsBake = true; 
                        }
                        if (o.children) o.children.forEach(addRecursive);
                    };
                    objs.forEach(addRecursive);
                    
                    if (this.engine && needsBake) {
                        // FIX: Automatically load textures for objects added mid-animation
                        this.engine.loadMeshesTextures(this.mobjects).then(() => {
                            this.engine.bakeMeshes(this.mobjects);
                            this.frameCount = 0;
                        });
                    } else {
                        this.frameCount = 0;
                    }
                }

                remove(...objs) {
                    let needsBake = false;
                    objs.forEach(o => {
                        const index = this.mobjects.indexOf(o);
                        if (index !== -1) { this.mobjects.splice(index, 1); if (o.triangles) needsBake = true; }
                    });
                    if (this.engine && needsBake) this.engine.bakeMeshes(this.mobjects);
                    this.frameCount = 0;
                }

                _stepTimeline(dt) {
                    let isAnimating = false;
                    if (this.activeAnimations.length > 0) {
                        isAnimating = true;
                        for (let i = this.activeAnimations.length - 1; i >= 0; i--) {
                            let group = this.activeAnimations[i];
                            if (group.isWait) {
                                group.timer += dt;
                                if (group.timer >= group.duration) { group.resolve(); this.activeAnimations.splice(i, 1); }
                            } else {
                                let allFinished = true;
                                group.animations.forEach(anim => {
                                    if (anim.finished) return;
                                    anim.t += dt; let rawAlpha = Math.min(anim.t / anim.run_time, 1.0);
                                    if (rawAlpha >= 1.0) { anim.finish(); anim.finished = true; }
                                    else { anim.update(anim.rate_func(rawAlpha)); allFinished = false; }
                                });
                                if (allFinished) { group.resolve(); this.activeAnimations.splice(i, 1); }
                            }
                        }
                    }
                    return isAnimating;
                }

                async rebuildScene(targetTime = 0) {
                    const curCam = this.camera;
                    this.mobjects = [];
                    this.activeAnimations = [];
                    this.clock = 0;

                    this.camera = { ...curCam };
                    if (this.cameraController) this.cameraController.camera = this.camera;

                    await this.setup();
                    this.construct();

                    if (targetTime > 0) {
                        const simDt = 1.0 / 60.0;
                        while (this.clock < targetTime) {
                            let step = Math.min(simDt, targetTime - this.clock);
                            this.clock += step;
                            this._stepTimeline(step);
                            const runUpdaters = (m, dt) => { m.updaters.forEach(fn => fn(m, dt)); if (m.children) m.children.forEach(c => runUpdaters(c, dt)); };
                            this.mobjects.forEach(m => runUpdaters(m, step));
                            if (this.alwaysUpdate) this.alwaysUpdate(step, this.clock);
                        }
                    }

                    if (this.engine) this.engine.bakeMeshes(this.mobjects);
                    populateSceneGraph(this.mobjects);
                    this.frameCount = 0;
                    document.getElementById('scrubber').value = this.clock;
                    document.getElementById('timeDisplay').innerText = this.clock.toFixed(2) + "s";
                }

                async setup() { }
                async construct() { }

                async run() {
                    this.engine = new RenderEngine(document.getElementById('canvas'));
                    this.cameraController = new CameraController(this.camera, document.getElementById('canvas'));
                    this.oidnManager = new OIDNManager(this.engine);
                    this.oidnReady = false; this.isProcessingOIDN = false;

                    // --- NEW: Debounce Window Resizing ---
                    let resizeTimeout = null;
                    window.addEventListener('resize', () => {
                        clearTimeout(resizeTimeout);
                        resizeTimeout = setTimeout(() => {
                            const vpNode = document.getElementById('viewport-container');
                            this.engine.resize(vpNode.clientWidth, vpNode.clientHeight);
                            this.frameCount = 0; // Reset accumulation after resize
                        }, 150); // Waits 150ms after dragging stops to avoid GPU context crashes
                    });

                    const btnRT = document.getElementById('btnToggleRT');
                    btnRT.addEventListener('click', () => {
                        this.cameraController.rtEnabled = !this.cameraController.rtEnabled; this.frameCount = 0;
                        if (this.cameraController.rtEnabled) {
                            btnRT.innerText = "Disable Ray Tracing (T)"; btnRT.style.background = "#d32f2f";
                            document.getElementById('status').innerText = "Status: Accumulating... (Clear)"; document.getElementById('status').style.color = "#4CAF50";
                        } else {
                            btnRT.innerText = "Enable Ray Tracing (T)"; btnRT.style.background = "var(--accent)";
                            document.getElementById('status').innerText = "Status: RT OFF (Preview)"; document.getElementById('status').style.color = "#9e9e9e";
                        }
                    });

                    const btnDoF = document.getElementById('btnToggleDoF');
                    btnDoF.addEventListener('click', () => {
                        this.cameraController.useDoF = !this.cameraController.useDoF; this.frameCount = 0;
                        if (this.cameraController.useDoF) { btnDoF.innerText = "Disable Focus Blur (B)"; btnDoF.style.background = "#7b1fa2"; }
                        else { btnDoF.innerText = "Enable Focus Blur (B)"; btnDoF.style.background = "#5e35b1"; }
                    });


                    document.getElementById('selBVHMethod').addEventListener('change', async (e) => {
                        const method = e.target.value;
                        this.engine.bvhMethod = method;

                        // 1. PAUSE THE ENGINE (Fixes the race condition)
                        this.isBaking = true;

                        this.mobjects.forEach(m => {
                            if (m.triangles) m.bvhDirty = true;
                        });

                        document.getElementById('status').innerText = `Status: Rebuilding BVH (${method.toUpperCase()})...`;
                        document.getElementById('status').style.color = "#FFC107";

                        // 2. Yield to the browser so the UI text actually updates
                        await new Promise(resolve => setTimeout(resolve, 20));

                        // 3. Bake the new BVH
                        this.engine.bakeMeshes(this.mobjects, method);

                        // 4. NOW that the new BVH is ready, reset the dynamic GPU buffers
                        this.mobjects.forEach(m => {
                            // If it's a dynamic mesh (like Water) that uses GPU setup
                            if (m.triangles && m.gpuSetupDone !== undefined) {
                                m.gpuSetupDone = false;
                                if (m.bufFlags) { m.bufFlags.destroy(); m.bufFlags = null; }
                                if (m.bufLeafIndices) { m.bufLeafIndices.destroy(); m.bufLeafIndices = null; }
                            }
                        });

                        this.frameCount = 0;

                        // 5. RESUME THE ENGINE
                        this.isBaking = false;
                    });


                    // --- NEW RT TECHNIQUE DROPDOWN LISTENER ---
                    document.getElementById('selRTTechnique').addEventListener('change', (e) => {
                        this.engine.rtTechnique = parseInt(e.target.value);
                        this.frameCount = 0;
                    });
                    document.getElementById('selCamModel').addEventListener('change', (e) => {
                        this.camera.model = parseInt(e.target.value);
                        this.frameCount = 0;
                    });

                    document.getElementById('uiFov').addEventListener('input', (e) => { this.camera.fov = parseFloat(e.target.value) * Math.PI / 180; this.frameCount = 0; });
                    document.getElementById('uiAperture').addEventListener('input', (e) => { this.camera.aperture = parseFloat(e.target.value); this.frameCount = 0; });
                    document.getElementById('uiFocus').addEventListener('input', (e) => { 
                        this.camera.focusDist = parseFloat(e.target.value); 
                        this.cameraController.autoFocus = false; 
                        this.frameCount = 0; });
                    document.getElementById('btnAutoFocus').addEventListener('click', () => { this.cameraController.autoFocus = !this.cameraController.autoFocus; this.cameraController.fPressed = true; });

                    document.getElementById('uiSkyIntensity').addEventListener('input', (e) => {
                        this.camera.skyIntensity = parseFloat(e.target.value);
                        document.getElementById('skyIntensityVal').innerText = this.camera.skyIntensity.toFixed(1);
                        this.frameCount = 0;
                    });
                    document.getElementById('uiGIMultiplier').addEventListener('input', (e) => {
                        this.camera.giMultiplier = parseFloat(e.target.value);
                        document.getElementById('giMultiplierVal').innerText = this.camera.giMultiplier.toFixed(1);
                        this.frameCount = 0;
                    });


                    // Dynamic UI logic for Camera Models
                    document.getElementById('selCamModel').addEventListener('change', (e) => {
                        this.camera.model = parseInt(e.target.value);
                        this.frameCount = 0;

                        // Show/Hide sliders based on the active camera type
                        document.getElementById('rowOrthoScale').style.display = this.camera.model === 1 ? 'flex' : 'none';
                        document.getElementById('rowFov').style.display = (this.camera.model === 1 || this.camera.model === 3) ? 'none' : 'flex';
                    });

                    // Lens Parameter Sliders
                    document.getElementById('uiOrthoScale').addEventListener('input', (e) => {
                        this.camera.orthoScale = parseFloat(e.target.value);
                        document.getElementById('orthoScaleVal').innerText = this.camera.orthoScale.toFixed(1);
                        this.frameCount = 0;
                    });
                    document.getElementById('uiLensShiftX').addEventListener('input', (e) => {
                        this.camera.lensShiftX = parseFloat(e.target.value);
                        document.getElementById('lensShiftXVal').innerText = this.camera.lensShiftX.toFixed(2);
                        this.frameCount = 0;
                    });
                    document.getElementById('uiLensShiftY').addEventListener('input', (e) => {
                        this.camera.lensShiftY = parseFloat(e.target.value);
                        document.getElementById('lensShiftYVal').innerText = this.camera.lensShiftY.toFixed(2);
                        this.frameCount = 0;
                    });

                    document.getElementById('selPreviewDenoiser').addEventListener('change', () => { this.frameCount = 0; this.oidnReady = false; });
                    document.getElementById('selOfflineDenoiser').addEventListener('change', () => { });
                    document.getElementById('inpPreviewSpp').addEventListener('change', () => { this.frameCount = 0; });
                    document.getElementById('inpBounces').addEventListener('input', (e) => { this.camera.bounces = parseInt(e.target.value); this.frameCount = 0; });

                    document.getElementById('btnRender').addEventListener('click', () => {
                        const fps = parseInt(document.getElementById('inpFps').value), dur = parseFloat(document.getElementById('inpDur').value), spp = parseInt(document.getElementById('inpSpp').value);
                        this.startOfflineRender(fps, dur, spp);
                    });

                    const btnPlay = document.getElementById('btnPlay');
                    const btnStop = document.getElementById('btnStop');
                    const btnLoop = document.getElementById('btnLoop');
                    const inpLoopStart = document.getElementById('inpLoopStart');
                    const inpLoopEnd = document.getElementById('inpLoopEnd');
                    const selSpeed = document.getElementById('selSpeed');
                    const scrubber = document.getElementById('scrubber');

                    btnPlay.addEventListener('click', () => {
                        this.isPlaying = !this.isPlaying;
                        btnPlay.innerText = this.isPlaying ? "⏸" : "▶";
                        btnPlay.classList.toggle('active', this.isPlaying);
                    });
                    btnPlay.classList.toggle('active', this.isPlaying);

                    btnStop.addEventListener('click', () => {
                        this.isPlaying = false; btnPlay.innerText = "▶"; btnPlay.classList.remove('active');
                        this.rebuildScene(0);
                    });

                    btnLoop.addEventListener('click', () => {
                        this.isLooping = !this.isLooping;
                        btnLoop.classList.toggle('active', this.isLooping);
                    });

                    inpLoopStart.addEventListener('change', (e) => { this.loopStart = Math.max(0, parseFloat(e.target.value)); });
                    inpLoopEnd.addEventListener('change', (e) => {
                        this.loopEnd = Math.max(this.loopStart + 0.5, parseFloat(e.target.value));
                        scrubber.max = this.loopEnd;
                    });
                    selSpeed.addEventListener('change', (e) => { this.playbackSpeed = parseFloat(e.target.value); });

                    let isScrubbing = false;
                    scrubber.addEventListener('mousedown', () => { isScrubbing = true; });
                    scrubber.addEventListener('input', (e) => { document.getElementById('timeDisplay').innerText = parseFloat(e.target.value).toFixed(2) + "s"; });
                    scrubber.addEventListener('change', async (e) => {
                        isScrubbing = false;
                        await this.rebuildScene(parseFloat(e.target.value));
                    });
                    this.isScrubbing = () => isScrubbing;

                    document.querySelectorAll('button, select, input').forEach(elem => {
                        // Always blur after a value is actually changed so hotkeys work again
                        elem.addEventListener('change', function () { this.blur(); });

                        // ONLY blur buttons on click. If you blur a select/input on click, it instantly closes/unfocuses!
                        if (elem.tagName.toLowerCase() === 'button') {
                            elem.addEventListener('click', function () { this.blur(); });
                        }
                    });
                    await this.engine.init();
                    await this.setup();
                    this.construct();

                    document.getElementById('status').innerText = "Status: Loading Textures & Baking BVH...";
                    document.getElementById('status').style.color = "#FFC107";

                    await this.engine.loadMeshesTextures(this.mobjects);
                    this.engine.bakeMeshes(this.mobjects);
                    populateSceneGraph(this.mobjects);

                    document.getElementById('status').innerText = "Status: Ready";
                    document.getElementById('status').style.color = "#9e9e9e";

                    requestAnimationFrame(async t => { this.lastTime = t; await this._loop(t); });
                }
            async _loop(time) {
                    if (window.isRenderingVideo || this.isBaking) {
                        this.lastTime = time; 
                        requestAnimationFrame(async t => await this._loop(t));
                        return;
                    }

                    const rawDt = (time - this.lastTime) / 1000.0;
                    this.lastTime = time;

                    const dt = Math.min(rawDt, 0.1) * this.playbackSpeed;

                    let isAnimating = false;
                    let updaterRan = false;

                    if (this.isPlaying && !this.isScrubbing()) {
                        this.clock += dt;

                        if (this.isLooping && this.clock >= this.loopEnd) {
                            this.rebuildScene(this.loopStart);
                            return;
                        }

                        isAnimating = this._stepTimeline(dt);

                        const runUpdaters = (m, dt) => { m.updaters.forEach(fn => { fn(m, dt); updaterRan = true; }); if (m.children) m.children.forEach(c => runUpdaters(c, dt)); };
                        this.mobjects.forEach(m => runUpdaters(m, dt));

                        if (this.alwaysUpdate) { this.alwaysUpdate(dt, this.clock); isAnimating = true; }

                        document.getElementById('scrubber').value = this.clock;
                        document.getElementById('timeDisplay').innerText = this.clock.toFixed(2) + "s";
                    }

                    if (updaterRan) isAnimating = true;

                    drawGimbal(this.camera);

                    if (globalVectorAtlas.textureReady && this.engine && this.engine.vectorTexture) {
                        this.engine.device.queue.copyExternalImageToTexture({ source: globalVectorAtlas.canvas }, { texture: this.engine.vectorTexture }, [globalVectorAtlas.canvas.width, globalVectorAtlas.canvas.height]);
                        globalVectorAtlas.textureReady = false; this.frameCount = 0;
                    }

                    if (this.cameraController) {
                        let safeDt = Math.min(rawDt, 0.1);
                        if (this.cameraController.update(safeDt, this.mobjects)) isAnimating = true;
                    }

                    if (isAnimating || this.isScrubbing()) {
                        this.frameCount = 0;
                        this.oidnReady = false;
                    }
                    if (!isAnimating && !this.isScrubbing() && this.frameCount > 8000 && this.cameraController.rtEnabled) {
                        requestAnimationFrame(async t => await this._loop(t));
                        return;
                    }

                    const previewSpp = parseInt(document.getElementById('inpPreviewSpp').value) || 1;
                    const activeSpp = previewSpp;

                    const originalBounces = this.camera.bounces;
                    if ((isAnimating || this.isScrubbing()) && this.cameraController.rtEnabled) {
                        this.camera.bounces = Math.min(originalBounces, 5);
                    }

                    // --- DYNAMIC OIDN DROPDOWN PARSER ---
                    const previewVal = document.getElementById('selPreviewDenoiser').value;
                    let previewDenoiserMode = 0;
                    if (previewVal === 'spatial') previewDenoiserMode = 1;
                    else if (previewVal !== 'none' && previewVal !== '0') previewDenoiserMode = 2; // OIDN Active

                    const isOidn = previewDenoiserMode === 2;
                    const oidnModel = isOidn ? previewVal : null; // Extracts the exact .tza filename

                    let denoiseStr = 'OFF';
                    if (previewDenoiserMode === 1) denoiseStr = 'FAST';
                    else if (isOidn) denoiseStr = oidnModel.toUpperCase();

                    document.getElementById('denoiseUI').innerText = `Denoiser: ${denoiseStr}`;
                    document.getElementById('denoiseUI').style.color = previewDenoiserMode === 0 ? '#777' : (previewDenoiserMode === 1 ? '#FFC107' : '#00bcd4');

                    if (isOidn && (!this.oidnManager.isInitialized || this.oidnManager.currentModel !== oidnModel)) {
                        this.oidnManager.init(oidnModel);
                    }

                    if (this.engine) {
                        // Pass the numeric mode to the shader
                        this.engine.device.queue.writeBuffer(this.engine.postProcBuffer, 0, new Float32Array([previewDenoiserMode, this.frameCount, this.oidnReady ? 1.0 : 0.0, 0]));

                        const activeDenoiser = (previewDenoiserMode === 1) && this.cameraController.rtEnabled;
                        this.engine.update(this.mobjects, this.camera, this.frameCount, activeDenoiser, this.cameraController.rtEnabled, this.cameraController.useDoF, activeSpp);
                        this.engine.render(this.frameCount, false, this.mobjects);
                    }

                    this.camera.bounces = originalBounces;

                    if (!isAnimating && !this.isScrubbing() && isOidn && this.cameraController.rtEnabled && !this.isProcessingOIDN && this.frameCount >= 4) {
                        this.isProcessingOIDN = true;
                        const startFrame = this.frameCount;

                        let f = async () => {
                            try {
                                await this.oidnManager.init(oidnModel);
                                await this.oidnManager.denoise(startFrame);
                                if (this.frameCount >= startFrame) { this.oidnReady = true; }
                            } catch (err) {
                                console.error("OIDN Async Error:", err);
                            } finally {
                                this.isProcessingOIDN = false;
                            }
                        };

                        // --- SMOOTH VIEWPORT STROBE FIX ---
                        if (this.frameCount < 60) {
                            if (this.frameCount % 5 === 0) f(); 
                            else this.isProcessingOIDN = false;
                        } else {
                            if (this.frameCount % 30 === 0) f(); 
                            else this.isProcessingOIDN = false;
                        }
                    }

                    document.getElementById('uiFov').value = (this.camera.fov * 180 / Math.PI);
                    document.getElementById('fovVal').innerText = `${(this.camera.fov * 180 / Math.PI).toFixed(0)}°`;
                    document.getElementById('uiAperture').value = this.camera.aperture;
                    document.getElementById('apertureVal').innerText = this.camera.aperture.toFixed(2) + (this.cameraController.useDoF ? '' : ' (X)');
                    document.getElementById('uiFocus').value = this.camera.focusDist;
                    document.getElementById('focusVal').innerText = this.camera.focusDist.toFixed(2) + (this.cameraController.autoFocus ? ' (A)' : '');

                    if (!this.cameraController.rtEnabled) {
                        document.getElementById('status').innerText = "Status: RT OFF (Fast Preview)"; document.getElementById('status').style.color = "#9e9e9e";
                        document.getElementById('frames').innerText = `Realtime Samples: 1 (RT OFF)`;
                    } else {
                        document.getElementById('frames').innerText = `Realtime Samples: ${(this.frameCount + 1) * activeSpp}`;

                        if (!this.isProcessingOIDN && !isOidn) {
                            if (isAnimating || this.isScrubbing()) { document.getElementById('status').innerText = "Status: Realtime Animated (Fast Mode)"; document.getElementById('status').style.color = "#ff9800"; }
                            else if (this.frameCount >= 8000) { document.getElementById('status').innerText = "Status: Converged (Paused)"; document.getElementById('status').style.color = "#9c27b0"; }
                            else { document.getElementById('status').innerText = "Status: Accumulating... (Clear)"; document.getElementById('status').style.color = "#4CAF50"; }
                        } else if (isOidn) {
                            if (isAnimating || this.isScrubbing()) { document.getElementById('status').innerText = "Status: Realtime Animated (Fast Mode)"; document.getElementById('status').style.color = "#ff9800"; }
                            else { document.getElementById('status').innerText = `Status: AI Denoising Asynchronously (${oidnModel})...`; document.getElementById('status').style.color = "#00bcd4"; }
                        }
                    }

                    this.frameCount++; requestAnimationFrame(async t => await this._loop(t));
                }

                async startOfflineRender(fps, duration, targetSpp) {
                    window.isRenderingVideo = true;
                    
                    // --- FORCE CLASSIC PATH TRACING FOR OFFLINE CLARITY ---
                    const originalTechnique = this.engine.rtTechnique;
                    this.engine.rtTechnique = 0; 
                    
                    document.getElementById('status').innerText = "Status: OFFLINE RENDERING...";
                    document.getElementById('status').style.color = "#e91e63";
                    document.getElementById('progressContainer').style.display = "block";

                    const totalFrames = fps * duration;
                    const dt = 1.0 / fps;

                    const resString = document.getElementById('selResolution').value;
                    const [targetW, targetH] = resString.split('x').map(Number);
                    this.engine.resize(targetW, targetH);

                    const tempCanvas = new OffscreenCanvas(this.engine.width, this.engine.height);
                    const tempCtx = tempCanvas.getContext('webgpu');
                    tempCtx.configure({
                        device: this.engine.device,
                        format: this.engine.presentationFormat,
                        alphaMode: 'opaque'
                    });

                    const { Muxer, ArrayBufferTarget } = await import('https://localhost:5173/lib/webm-muxer.mjs');
                    const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'V_VP9', width: this.engine.width, height: this.engine.height } });

                    const videoEncoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => console.error("VideoEncoder error:", e) });
                    videoEncoder.configure({ codec: 'vp09.00.10.08', width: this.engine.width, height: this.engine.height, bitrate: 15_000_000, framerate: fps });

                    const cleanupObject = (m) => { if (m instanceof VideoObject) { m.video.pause(); m.video.removeAttribute('src'); m.video.load(); } if (m.children) m.children.forEach(cleanupObject); };
                    this.mobjects.forEach(cleanupObject);
                    globalVectorAtlas.clear();

                    this.mobjects = []; this.activeAnimations = []; this.clock = 0;

                    const curCam = this.camera;
                    const offlineBounces = parseInt(document.getElementById('inpOfflineBounces').value) || 5;

                    this.camera = {
                        ...curCam, 
                        pos: [...curCam.pos], dir: [...curCam.dir], right: [...curCam.right], up: [...curCam.up], skyColor: [...curCam.skyColor], 
                        bounces: offlineBounces
                    };

                    if (this.cameraController) {
                        this.cameraController.camera = this.camera;
                        this.cameraController.keys = {};
                    }

                    await this.setup(); this.construct(); await Promise.resolve();

                    await this.engine.loadMeshesTextures(this.mobjects);
                    this.engine.bakeMeshes(this.mobjects);
                    populateSceneGraph(this.mobjects);

                    // --- DYNAMIC OFFLINE OIDN PARSER ---
                    const offlineVal = document.getElementById('selOfflineDenoiser').value;
                    let offlineDenoiserMode = 0;
                    if (offlineVal === 'spatial') offlineDenoiserMode = 1;
                    else if (offlineVal !== 'none' && offlineVal !== '0') offlineDenoiserMode = 2;

                    const isOfflineOidn = offlineDenoiserMode === 2;
                    const offlineOidnModel = isOfflineOidn ? offlineVal : null;
                    const tileSizeSelect = parseInt(document.getElementById('selTileSize').value);

                    const tiles = [];
                    if (tileSizeSelect > 0) {
                        for (let y = 0; y < this.engine.height; y += tileSizeSelect) {
                            for (let x = 0; x < this.engine.width; x += tileSizeSelect) {
                                tiles.push({ x, y, width: Math.min(tileSizeSelect, this.engine.width - x), height: Math.min(tileSizeSelect, this.engine.height - y) });
                            }
                        }
                    } else {
                        tiles.push({ x: 0, y: 0, width: this.engine.width, height: this.engine.height });
                    }

                    for (let frame = 0; frame < totalFrames; frame++) {
                        this.clock = frame * dt; this._stepTimeline(dt);

                        const runUpdaters = (m, dt) => { m.updaters.forEach(fn => fn(m, dt)); if (m.children) m.children.forEach(c => runUpdaters(c, dt)); };
                        this.mobjects.forEach(m => runUpdaters(m, dt));
                        if (this.alwaysUpdate) this.alwaysUpdate(dt, this.clock);

                        let accFrame = 0; 
                        const passes = Math.ceil(targetSpp / 4);
                        this.engine.useScissor = tileSizeSelect > 0;
                        
                        // LOCKED NOISE SEQUENCE: Resets to 0 every frame to prevent boiling video noise!
                        let globalPassIndex = 0; 

                        for (let p = 0; p < passes; p++) {
                            this.engine.device.queue.writeBuffer(this.engine.postProcBuffer, 0, new Float32Array([0, accFrame, 0, 0]));
                            
                            this.engine.update(this.mobjects, this.camera, accFrame, false, true, this.cameraController.useDoF, 4, globalPassIndex);

                            for (let i = 0; i < tiles.length; i++) {
                                this.engine.tileRect = tiles[i];
                                const skipMorph = (i > 0); const skipScreen = true;
                                this.engine.render(accFrame, true, this.mobjects, skipMorph, skipScreen);
                            }

                            accFrame++;
                            globalPassIndex++;
                            document.getElementById('progressText').innerText = `Frame ${frame + 1} / ${totalFrames} (Pass ${p + 1}/${passes})`;
                            await this.engine.device.queue.onSubmittedWorkDone();
                            await new Promise(r => setTimeout(r, 15));
                        }

                        this.engine.useScissor = false;

                        if (isOfflineOidn) {
                            document.getElementById('progressText').innerText = `Frame ${frame + 1} / ${totalFrames} (AI Denoising [${offlineOidnModel}]...)`;
                            
                            await this.oidnManager.init(offlineOidnModel);
                            await this.oidnManager.denoise(accFrame - 1);

                            await this.engine.device.queue.onSubmittedWorkDone();
                            this.engine.device.queue.writeBuffer(this.engine.postProcBuffer, 0, new Float32Array([offlineDenoiserMode, accFrame, 1.0, 0]));
                        } else {
                            this.engine.device.queue.writeBuffer(this.engine.postProcBuffer, 0, new Float32Array([offlineDenoiserMode, accFrame, 0.0, 0]));
                        }

                        const finalBg = (accFrame - 1) % 2 === 0 ? this.engine.screenBgA : this.engine.screenBgB;
                        const enc = this.engine.device.createCommandEncoder();

                        const targetTexture = tempCtx.getCurrentTexture();

                        const screenPass = enc.beginRenderPass({
                            colorAttachments: [{
                                view: targetTexture.createView(),
                                loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store'
                            }]
                        });
                        screenPass.setPipeline(this.engine.screenPipeline);
                        screenPass.setBindGroup(0, finalBg);
                        screenPass.draw(3, 1, 0, 0);
                        screenPass.end();

                        this.engine.device.queue.submit([enc.finish()]);
                        await this.engine.device.queue.onSubmittedWorkDone();

                        const videoFrame = new VideoFrame(tempCanvas, { timestamp: Math.round((frame * 1_000_000) / fps) });

                        videoEncoder.encode(videoFrame, { keyFrame: (frame % (fps * 2) === 0) });
                        videoFrame.close();

                        while (videoEncoder.encodeQueueSize > 5) { await new Promise(r => setTimeout(r, 10)); }
                        document.getElementById('progressFill').style.width = `${((frame + 1) / totalFrames) * 100}%`;
                    }

                    document.getElementById('progressText').innerText = `Muxing video... Please wait.`;
                    await videoEncoder.flush(); muxer.finalize();

                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(new Blob([muxer.target.buffer], { type: 'video/webm' }));
                    a.download = 'webgpu_cinematic_render.webm'; a.click();

                    this.camera.bounces = parseInt(document.getElementById('inpBounces').value) || 5;

                    const vpNode = document.getElementById('viewport-container');
                    this.engine.resize(vpNode.clientWidth, vpNode.clientHeight);
                    
                    // --- RESTORE ORIGINAL RT TECHNIQUE ---
                    this.engine.rtTechnique = originalTechnique;

                    if (this.cameraController) this.cameraController.keys = {};

                    window.isRenderingVideo = false; document.getElementById('progressContainer').style.display = "none";
                    this.frameCount = 0; this.oidnReady = false; this.lastTime = performance.now();
                    requestAnimationFrame(async t => await this._loop(t));
                }
        }

            // ==========================================
            // Classic Cornell Box Demo Scene
            // ==========================================
            class CornellBoxScene extends Scene {
                async setup() {
                    // To fetch the scene, replace with your actual file URL or local server string
                    this.scene = await loadOBJFromURL("https://localhost:5173/res/model/raytraced-scene.obj", true);
                }

                async construct() {
                    this.camera.pos = [-0.1, 0.5, 5.4];
                    this.camera.dir = Math3D.normalize(Math3D.sub([-0.1, 0.5, 0], this.camera.pos));

                    if (this.scene) {
                        this.scene.position = [0, 0, 0];
                        this.add(this.scene);
                    }
                }
            }


            class NativeWaterScene extends Scene {
                async setup() {
                    // 1. Initialize the Native WebGPU Water
                    this.water = new NativeGPUWater(500, 15.0);
                    this.water.scene = this;

                    // DELETE the old initTaichi / initGPU call here!
                    // The water will automatically init itself the moment the Engine builds the BVH.

                    // 2. Create a "Pool Floor" out of a basic plane
                    let poolTris = [[[-6, -1.5, -6], [6, -1.5, -6], [6, -1.5, 6], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 0], [1, 0], [1, 1]],
                    [[-6, -1.5, -6], [6, -1.5, 6], [-6, -1.5, 6], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 0], [1, 1], [0, 1]]
                    ];
                    this.pool = new MeshObject(poolTris, false);
                    this.pool.set_material([0.2, 0.6, 0.8], 0.2);

                    // 3. Add a couple of floating spheres for refraction aesthetic
                    this.sphere1 = new Sphere(1.5);
                    this.sphere1.position = [-2.0, 0.0, -1.5];
                    this.sphere1.set_material([1.0, 0.2, 0.3], 0.9, 0.0); // Shiny red

                    this.sphere2 = new Sphere(1.0);
                    this.sphere2.position = [2.5, 0.5, 2.0];
                    this.sphere2.set_material([1.0, 1.0, 1.0], 1.0, 0.8, 1.5); // Glass
                }

                async construct() {
                    // Set up the Camera looking down at the pool
                    this.camera.pos = [0.0, 4.5, 9.0];
                    this.camera.dir = Math3D.normalize(Math3D.sub([0.0, 0.0, 0.0], this.camera.pos));
                    this.camera.skyColor = [0.05, 0.05, 0.08]; // Darker dramatic sky
                    this.camera.skyIntensity = 1.5;
                    this.camera.giMultiplier = 1.2;

                    // Add meshes to scene. The engine will now build the BVH, 
                    // and NativeGPUWater will automatically bind to it on the first frame!
                    this.add(this.pool, this.water, this.sphere1, this.sphere2);
                }
            }

            class TaichiWaterScene extends Scene {
                async setup() {
                    // 1. Initialize the Taichi Water
                    this.water = new TaichiWater(45, 12.0);
                    await this.water.initTaichi(this.engine);

                    // 2. Create a "Pool Floor" out of a basic plane
                    let poolTris = [[[-6, -1.5, -6], [6, -1.5, -6], [6, -1.5, 6], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 0], [1, 0], [1, 1]],
                    [[-6, -1.5, -6], [6, -1.5, 6], [-6, -1.5, 6], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 0], [1, 1], [0, 1]]
                    ];
                    this.pool = new MeshObject(poolTris, false);
                    // Tiled checkerboard-like blue tiles
                    this.pool.set_material([0.2, 0.6, 0.8], 0.2);

                    // 3. Add a couple of floating spheres for refraction aesthetic
                    this.sphere1 = new Sphere(1.5);
                    this.sphere1.position = [-2.0, 0.0, -1.5];
                    this.sphere1.set_material([1.0, 0.2, 0.3], 0.9, 0.0); // Shiny red

                    this.sphere2 = new Sphere(1.0);
                    this.sphere2.position = [2.5, 0.5, 2.0];
                    this.sphere2.set_material([1.0, 1.0, 1.0], 1.0, 0.8, 1.5); // Glass
                }

                async construct() {
                    // Set up the Camera looking down at the pool
                    this.camera.pos = [0.0, 4.5, 9.0];
                    this.camera.dir = Math3D.normalize(Math3D.sub([0.0, 0.0, 0.0], this.camera.pos));
                    this.camera.skyColor = [0.05, 0.05, 0.08]; // Darker dramatic sky
                    this.camera.skyIntensity = 1.5;
                    this.camera.giMultiplier = 1.2;

                    // Provide the meshes to the path tracer
                    this.water.scene = this;
                    this.add(this.pool, this.water, this.sphere1, this.sphere2);
                }
            }



            // ==========================================
            // Helper Classes for Voxel Room Scene
            // ==========================================
            // Generates perfectly flat-shaded box triangles with UV scaling
            function createBoxTris(w, h, d, tileU = 1, tileV = 1) {
                let x = w / 2, y = h / 2, z = d / 2;
                let p = [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z], // Front
                [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z]  // Back
                ];
                let n = [
                    [0, 0, 1], [0, 0, -1], [-1, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0]
                ];
                let tris = [];
                function addFace(v0, v1, v2, v3, norm, wU, hV) {
                    let uv = [[0, 0], [wU * tileU, 0], [wU * tileU, hV * tileV], [0, hV * tileV]];
                    tris.push([p[v0], p[v1], p[v2], norm, norm, norm, uv[0], uv[1], uv[2]]);
                    tris.push([p[v0], p[v2], p[v3], norm, norm, norm, uv[0], uv[2], uv[3]]);
                }
                addFace(0, 1, 2, 3, n[0], w, h); // Front
                addFace(5, 4, 7, 6, n[1], w, h); // Back
                addFace(4, 0, 3, 7, n[2], d, h); // Left
                addFace(1, 5, 6, 2, n[3], d, h); // Right
                addFace(3, 2, 6, 7, n[4], w, d); // Top
                addFace(4, 5, 1, 0, n[5], w, d); // Bottom
                return tris;
            }

            // Standard Box Mesh
            class Box extends MeshObject {
                constructor(w, h, d, color, tileU = 1, tileV = 1) {
                    super(createBoxTris(w, h, d, tileU, tileV), false); // false = Flat Shaded
                    this.set_material(color, 0.1, 0.0, 1.5, [0, 0, 0], 0.0);
                }
            }

            // Pure Light Source Box
            class LightBox extends MeshObject {
                constructor(w, h, d, color, strength) {
                    super(createBoxTris(w, h, d), false);
                    this.set_material([0, 0, 0], 0.1, 0.0, 1.5, color, strength);
                }
            }

            // Procedural Texture Generators
            function generateDotTexture(baseHex, dotHex) {
                const canvas = document.createElement('canvas');
                canvas.width = 128; canvas.height = 128;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = baseHex;
                ctx.fillRect(0, 0, 128, 128);
                ctx.fillStyle = dotHex;
                ctx.beginPath();
                ctx.arc(64, 64, 38, 0, Math.PI * 2);
                ctx.fill();
                return canvas.toDataURL('image/png');
            }

            function generateSlatTexture(baseHex, lineHex) {
                const canvas = document.createElement('canvas');
                canvas.width = 128; canvas.height = 128;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = baseHex;
                ctx.fillRect(0, 0, 128, 128);
                ctx.fillStyle = lineHex;
                ctx.fillRect(122, 0, 6, 128); // Wood groove
                return canvas.toDataURL('image/png');
            }



            class VoxelRoomScene extends Scene {
                async setup() {
                    const pegboardTex = generateDotTexture('#E67E22', '#5D3A1A');
                    const bedTex = generateDotTexture('#58D68D', '#1D8348');
                    const floorTex = generateSlatTexture('#D5D8DC', '#808B96');

                    // 2. Floor & Walls
                    this.floor = new Box(12, 0.5, 12, [1, 1, 1], 2, 2);
                    this.floor.position = [0, -0.25, 0];
                    this.floor.albedoUrl = floorTex;

                    this.leftWall = new Box(0.5, 10, 12, [1, 1, 1], 2, 2);
                    this.leftWall.position = [-6.25, 5, 0];
                    this.leftWall.albedoUrl = pegboardTex;

                    const wallColor = [0.85, 0.85, 0.9];
                    this.rwBase = new Box(12, 1.5, 0.5, wallColor); this.rwBase.position = [0, 0.75, -6.25];
                    this.rwTop = new Box(12, 3, 0.5, wallColor); this.rwTop.position = [0, 8.5, -6.25];
                    this.rwP1 = new Box(3, 5.5, 0.5, wallColor); this.rwP1.position = [-4.5, 4.25, -6.25];
                    this.rwP2 = new Box(2, 5.5, 0.5, wallColor); this.rwP2.position = [0, 4.25, -6.25];
                    this.rwP3 = new Box(4, 5.5, 0.5, wallColor); this.rwP3.position = [4.0, 4.25, -6.25];

                    // 3. Emissive Lights
                    this.lightYellow = new LightBox(2, 5.5, 0.2, [1.0, 0.2, 0.0], 0.0);
                    this.lightYellow.position = [-2.0, 4.25, -6.6];
                    this.lightBlue = new LightBox(1.5, 5.5, 0.2, [0.01, 0.2, 1.0], 0.0);
                    this.lightBlue.position = [1.5, 4.25, -6.6];

                    // 4. Furniture
                    this.bed = new Box(3.5, 0.6, 6, [1, 1, 1], 2.5, 2.5);
                    this.bed.position = [-1.5, 0.3, 1.0];
                    this.bed.albedoUrl = bedTex;
                    this.pillow = new Box(2.5, 0.3, 1.2, [0.95, 0.95, 1.0]);
                    this.pillow.position = [-1.5, 0.75, -1.0];

                    const furnColor = [0.9, 0.9, 0.95];
                    const deskTop = new Box(2.5, 0.2, 4.0, furnColor); deskTop.position = [-4.8, 3.0, 2.5];
                    const deskLeg1 = new Box(0.2, 3.0, 0.2, furnColor); deskLeg1.position = [-3.7, 1.5, 1.0];
                    const deskLeg2 = new Box(0.2, 3.0, 0.2, furnColor); deskLeg2.position = [-3.7, 1.5, 4.0];
                    this.deskGroup = new Group(deskTop, deskLeg1, deskLeg2);
                    // this.deskGroup.opacity = 0.5;
                    // this.deskGroup.set_material(Material.TransparentNoRefraction([0.4, 0.7, 1.0], 1.0)); 

                    deskTop.set_material([1,1, 1.0], 1.0, 0.1, 0.0);

                    this.shelf1 = new Box(1.5, 0.2, 3.5, furnColor); this.shelf1.position = [-5.4, 4.5, 2.5];
                    this.shelf2 = new Box(1.5, 0.2, 3.5, furnColor); this.shelf2.position = [-5.4, 5.8, 2.5];
                    this.cabinet = new Box(1.5, 2.5, 2.0, furnColor); this.cabinet.position = [-5.4, 7.5, -2.0];

                    // 1. Blue Glass Cube
                    this.cube1 = new Box(1.2, 1.2, 1.2, [0.4, 0.7, 1.0]);
                    this.cube1.position = [4.0, 0.6, 1.0];
                    // Parameters: color, smoothness, transparency, ior
                    this.cube1.set_material([0.4, 0.7, 1.0], 1.0, 0.9, 1.5); 

                    // 2. Red Glass Cube
                    this.cube2 = new Box(0.9, 0.9, 0.9, [1.0, 0.4, 0.4]);
                    this.cube2.position = [3.8, 1.65, 0.9];
                    // Using transparency of 0.9 makes it clear glass, IOR of 1.5 is the physical constant for glass
                    this.cube2.set_material([1.0, 0.4, 0.4], 1.0, 0.9, 1.5);
                }

                async construct() {
                    // --- INITIAL CAMERA & AMBIENT ---
                    this.camera.pos = [15, 12, 15];
                    this.camera.dir = Math3D.normalize(Math3D.sub([0, 2, 0], this.camera.pos));
                    const skyFade = new ValueTracker(2.0);
                    skyFade.add_updater((v, dt) => { this.camera.skyIntensity = v.get_value(); });

                    // FIX 1: Start with high sky intensity so we can see the construction
                    // --- NIGHT TIME SETTINGS ---
                    this.camera.pos = [15, 6, 15];
                    this.camera.dir = Math3D.normalize(Math3D.sub([0, 2, 0], this.camera.pos));
                    this.camera.skyColor = [0.02, 0.04, 0.1]; // Deep Night Blue (Moonlight)
                    this.camera.skyIntensity = 0.4;           // Enough to see silhouettes
                    this.camera.giMultiplier = 2.5;           // High GI for cozy light bounces

                    // --- STEP 1: THE FLOOR & LIGHTS ---
                    // FIX 2: Bring the lights in at the very beginning so they illuminate the room
                    
                  
                    await this.play(
                        new Create(this.lightYellow, { run_time: 1.0 }),
                        new Create(this.lightBlue, { run_time: 1.0 })
                    );
                    this.play(new MoveCamera(this.camera, {
                            pos: [8, 13, 12],
                            dir: Math3D.normalize(Math3D.sub([-2, 2, 0], [8, 13, 12])),
                            fov: 40 * Math.PI / 180,
                            focusDist: 14.0
                        }, { run_time: 6.0 }),
                        );
                    this.play(
                    this.lightYellow.animate({ 
                        run_time: 5.0, 
                        rate_func: rate_functions.easeIn // Glow starts slow then accelerates
                    })
                    .set_material([1.0, 0.6, 0.1], 0.1, 0, 1.5, [1.0, 0.2, 0.0], 8.0)
                    .build(),

                    this.lightBlue.animate({ 
                        run_time: 5.0, 
                        rate_func: rate_functions.smooth // Gentle start and finish
                    })
                    .set_material([0.1, 0.4, 1.0], 0.1, 0, 1.5, [0.01, 0.4, 1.0], 8.0)
                    .build(),

                        skyFade.animate({ run_time: 6.0 }).set_value(0.2).build(),
                    );
                    await this.play(
                        new Create(this.floor, { run_time: 1.5 }),
                    );


                    // // --- STEP 2: WALLS ---
                    await this.play(
                        new Create(this.leftWall, { run_time: 1.0 }),
                        new Create(this.rwBase, { run_time: 0.5 }),
                        new Create(this.rwTop, { run_time: 0.5 }),
                        new Create(this.rwP1, { run_time: 0.5 }),
                        new Create(this.rwP2, { run_time: 0.5 }),
                        new Create(this.rwP3, { run_time: 0.5 })
                    );

                    // --- STEP 3: FURNITURE ASSEMBLY ---
                    await this.play(
                        new Create(this.bed, { run_time: 1.2, rate_func: rate_functions.easeIn }),
                        new Create(this.deskGroup, { run_time: 1.2, rate_func: rate_functions.easeIn }),
                        new Create(this.pillow, { run_time: 0.8 }),
                        new Create(this.shelf1, { run_time: 0.5 }),
                        new Create(this.shelf2, { run_time: 0.5 }),
                        new Create(this.cabinet, { run_time: 0.5 })
                    );

                    // --- STEP 4: CINEMATIC SWEEP & LIGHT TRANSITION ---
                    this.cube1.add_updater((m, dt) => m.rotate(0, dt * 1.5, 0));
                    this.cube2.add_updater((m, dt) => m.rotate(dt, dt, 0));
                    
                    // FIX 3: Fade out the sky light as the camera moves in for that "cinematic" look
                    
                    await this.play(
                        
                        new Create(this.cube1, { run_time: 1.0 }),
                        new Create(this.cube2, { run_time: 1.0 })
                    );

                    // --- STEP 5: FINAL INDICATE ---
                    await this.play(new Indicate(this.cube2, { run_time: 1.5 }));



                    // await this.play(
                    //     new MoveCamera(this.camera, {
                    //         pos: [7.5, 4.5, 8.5],
                    //         dir: Math3D.normalize(Math3D.sub([4.0, 1.0, 1.0], [7.5, 4.5, 8.5])),
                    //         focusDist: 5.5,   // Focus specifically on the cubes
                    //         aperture: 0.35,   // Increase blur depth
                    //         fov: 35 * Math.PI / 180
                    //     }, { 
                    //         run_time: 4.0, 
                    //         rate_func: rate_functions.smooth 
                    //     }),
                    //     new Indicate(this.cube1, { run_time: 2.0 })
                    // );
                    await this.wait(2.0);
                }
            }


            // Boot the Engine
            window.onload = () => {
                const scene = new VoxelRoomScene();
                scene.run();
            };
        