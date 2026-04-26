
            
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
            struct Material {
                color:        vec3<f32>,
                roughness:    f32,       // 0 = mirror, 1 = fully rough (was 'smoothness')
                emColor:      vec3<f32>,
                emStrength:   f32,
                transmission: f32,       // glass weight (was 'transparency')
                ior:          f32,
                metallic:     f32,
                specular:     f32,       // dielectric F0 level: 0.5 = 4% (Blender default)
                opacity:      f32,       // stochastic alpha cutout
            }

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
            
            // NOTE: All BRDF evaluation logic has been moved to brdf.wgsl
            // eval_bsdf() replaces the old eval_contribution()
            // bsdf_scatter() replaces the old inline scattering logic



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

                        // Buffer layout:
                        // mat0: color.rgb + roughness
                        // mat1: emColor.rgb + emStrength
                        // mat2: transmission, ior, metallic, specular
                        // prevPosRad.w: opacity
                        rec.mat.color        = s.mat0.rgb;
                        rec.mat.roughness    = s.mat0.a;
                        rec.mat.emColor      = s.mat1.rgb;
                        rec.mat.emStrength   = s.mat1.a;
                        rec.mat.transmission = s.mat2.x;
                        rec.mat.ior          = max(1.0, s.mat2.y);
                        rec.mat.metallic     = s.mat2.z;
                        rec.mat.specular     = s.mat2.w;
                        rec.mat.opacity      = s.prevPosRad.w;
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

                    // Stochastic opacity at intersection level
                    let sph_opacity = s.prevPosRad.w;
                    if (sph_opacity < 1.0) {
                        if (!rt_enabled_bool && sph_opacity < 0.5) { continue; }
                        if (rt_enabled_bool && rand_float(rngState) > sph_opacity) { continue; }
                    }

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
                    // Bitfield decode: vectorType in bits 0-3, isSmooth in bit 4
                    let flags_u = bitcast<u32>(mat2_z);
                    let vectorType = i32(flags_u & 0xFu);
                    let isVector   = vectorType > 0;
                    let isSmooth   = (flags_u >> 4u) & 1u;

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
                                    
                                    // Stochastic material opacity at intersection level
                                    let meshOpacity = mesh.aabbMin.w;
                                    if (meshOpacity < 1.0) {
                                        if (!rt_enabled_bool) {
                                            if (meshOpacity < 0.5) { isValidHit = false; }
                                        } else {
                                            if (rand_float(rngState) > meshOpacity) { isValidHit = false; }
                                        }
                                    }

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

                                        closest.mat.color        = mesh.mat0.rgb * texColor.rgb;
                                        closest.mat.roughness    = mesh.mat0.a;
                                        closest.mat.emColor      = mesh.mat1.rgb * texColor.rgb;
                                        closest.mat.emStrength   = mesh.mat1.a;
                                        closest.mat.transmission = mesh.mat2.x;
                                        closest.mat.ior          = max(1.0, mesh.mat2.y);
                                        // mat2.z = packed flags (already decoded above)
                                        closest.mat.metallic     = mesh.mat2.w;
                                        closest.mat.specular     = mesh.aabbMax.w; // free slot
                                        closest.mat.opacity      = mesh.aabbMin.w;


                                        let edge1 = tri.v1.xyz - tri.v0.xyz; 
                                        let edge2 = tri.v2.xyz - tri.v0.xyz;
                                        let localGeomNormal = normalize(cross(edge1, edge2));
                                        var worldGeomNormal = normalize((vec4<f32>(localGeomNormal, 0.0) * mesh.invModelMatrix).xyz);

                                        var localNormal: vec3<f32>;
                                        if (isSmooth != 0u) { localNormal = normalize(tri.n0.xyz * w + tri.n1.xyz * res.y + tri.n2.xyz * res.z); } 
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
        
fn evaluateFallbackShading(
    gb_p: vec4<f32>, 
    gb_n: vec4<f32>, 
    gb_a: vec4<f32>, 
    cameraRayOrigin: vec3<f32>,
    dirToScreen: vec3<f32>,
    metallic: f32,
    rngState: ptr<function, u32>
) -> vec4<f32> {
    if (gb_a.a < -0.5) {
        let ray = Ray(cameraRayOrigin, dirToScreen, 1.0 / dirToScreen);
        return vec4<f32>(getSkyColor(ray), 1.0);
    }
    
    let N = normalize(gb_n.xyz); let V = -dirToScreen;
    let R = reflect(-V, N);
    
    let L1 = normalize(vec3<f32>(0.5, 1.0, -0.5)); 
    let L2 = normalize(vec3<f32>(-0.8, -0.6, 0.5)); 
    
    let L1_up = vec3<f32>(0.0, 1.0, 0.0);
    
    // ONE-BOUNCE DIRECTIONAL SHADOW
    // Since true soft shadows require thousands of stochastic rays (Raytracing Mode),
    // Preview Mode uses a single, ultra-fast crisp hard shadow to maintain 60 FPS.
    let shadowRay = Ray(gb_p.xyz + N * 0.01, L1, 1.0 / L1);
    let shadowHit = worldHit(shadowRay, rngState);
    let shadowVis = select(1.0, 0.05, shadowHit.hit);
    
    let NdotL1 = max(dot(N, L1), 0.0) * shadowVis;
    let NdotL2 = max(dot(N, L2), 0.0);
    
    let skyColor = cam.skyData.xyz * cam.skyData.w;
    let skyWeight = 0.5 * (N.y + 1.0);
    let ambient = mix(vec3<f32>(0.08), skyColor, skyWeight);
    
    // gb_n.w now stores roughness (0=mirror, 1=rough); convert for Blinn-Phong preview
    let roughness  = clamp(gb_n.w, 0.0, 1.0);
    let smoothness = 1.0 - roughness;

    let H1 = normalize(L1 + V); let spec1 = pow(max(dot(N, H1), 0.0), max(128.0 * smoothness, 4.0)) * smoothness * 2.0 * shadowVis;
    let H2 = normalize(L2 + V); let spec2 = pow(max(dot(N, H2), 0.0), max(32.0 * smoothness, 2.0)) * smoothness * 0.4;
    
    let NdotV = max(dot(N, V), 0.0);
    let fresnel = pow(1.0 - NdotV, 5.0);
    
    var diffuseColor = gb_a.rgb * (NdotL1 * 1.5 + NdotL2 * 0.25 + ambient * 0.4);
    
    let safeR = R + vec3<f32>(0.001);
    let skyReflection = getSkyColor(Ray(gb_p.xyz, safeR, 1.0 / safeR));
    
    let specColorBase = mix(vec3<f32>(1.0), gb_a.rgb, metallic);
    var specularColor = specColorBase * (spec1 + spec2) + skyReflection * smoothness * mix(0.15, 1.0, fresnel);
    
    var matColor = diffuseColor + specularColor;
    
    // gb_a.a: 1.0=emissive, 0.0=diffuse, -1.0=sky (clamp prevents emissive over-brightening in preview)
    matColor += gb_a.rgb * clamp(gb_a.a, 0.0, 1.0);
    
    if (gb_p.w > 0.0) {
        let safeV = V + vec3<f32>(0.001);
        let ray = Ray(gb_p.xyz - V * 0.001, -V, 1.0 / -safeV);
        matColor = mix(matColor, getSkyColor(ray), max(gb_p.w - fresnel * 0.8, 0.0));
    }
    return vec4<f32>(matColor, 1.0);
}
