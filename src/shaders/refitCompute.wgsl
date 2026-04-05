
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
            