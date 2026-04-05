
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
            