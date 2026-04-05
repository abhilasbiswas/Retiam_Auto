// Radiance Cascades (Deterministic 5D Sannikov Implementation)

@group(2) @binding(0) var<storage, read_write> cascadeProbes: array<vec4<f32>>;
@group(2) @binding(1) var<storage, read> prevCascadeProbes: array<vec4<f32>>;

const C0_OFFSET = 0u;
const C1_OFFSET = 524288u;
const C2_OFFSET = 786432u;
const C3_OFFSET = 917504u;

fn getGridRes(level: u32) -> vec3<f32> {
    if (level == 0u) { return vec3<f32>(32.0); }
    if (level == 1u) { return vec3<f32>(16.0); }
    if (level == 2u) { return vec3<f32>(8.0); }
    return vec3<f32>(4.0);
}

fn getAngRes(level: u32) -> vec2<f32> {
    if (level == 0u) { return vec2<f32>(4.0); }
    if (level == 1u) { return vec2<f32>(8.0); }
    if (level == 2u) { return vec2<f32>(16.0); }
    return vec2<f32>(32.0);
}

fn getBaseOffset(level: u32) -> u32 {
    if (level == 0u) { return C0_OFFSET; }
    if (level == 1u) { return C1_OFFSET; }
    if (level == 2u) { return C2_OFFSET; }
    return C3_OFFSET;
}

fn getProbeIndexSafe(level: u32, gridPos: vec3<i32>, angID: vec2<i32>) -> u32 {
    let gRes = vec3<i32>(getGridRes(level));
    let aRes = vec2<i32>(getAngRes(level));
    
    // Clamp wrapped bounds securely
    let g = clamp(gridPos, vec3<i32>(0), gRes - vec3<i32>(1));
    let a = clamp(angID, vec2<i32>(0), aRes - vec2<i32>(1)); // Should theoretically wrap spherically, but clamp for VRAM safety
    
    let gridLinear = u32(g.x + g.y * gRes.x + g.z * gRes.x * gRes.y);
    let angLinear = u32(a.x + a.y * aRes.x);
    
    let numAng = u32(aRes.x * aRes.y);
    return getBaseOffset(level) + gridLinear * numAng + angLinear;
}

fn signNotZero(v: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(select(-1.0, 1.0, v.x >= 0.0), select(-1.0, 1.0, v.y >= 0.0));
}

fn octEncode(v: vec3<f32>) -> vec2<f32> {
    var p = v.xy * (1.0 / (abs(v.x) + abs(v.y) + abs(v.z)));
    if (v.z < 0.0) {
        let sy = select(-1.0, 1.0, p.y >= 0.0);
        let sx = select(-1.0, 1.0, p.x >= 0.0);
        p = vec2<f32>((1.0 - abs(p.y)) * sx, (1.0 - abs(p.x)) * sy);
    }
    return p * 0.5 + 0.5; // [0, 1]
}

fn octDecode(pIn: vec2<f32>) -> vec3<f32> {
    let p = pIn * 2.0 - 1.0;
    var v = vec3<f32>(p.x, p.y, 1.0 - abs(p.x) - abs(p.y));
    if (v.z < 0.0) {
        let sy = select(-1.0, 1.0, v.y >= 0.0);
        let sx = select(-1.0, 1.0, v.x >= 0.0);
        let ox = v.x;
        v.x = (1.0 - abs(v.y)) * sx;
        v.y = (1.0 - abs(ox)) * sy;
    }
    return normalize(v);
}

fn getDir(level: u32, angID: vec2<i32>) -> vec3<f32> {
    let aRes = getAngRes(level);
    let uv = (vec2<f32>(angID) + vec2<f32>(0.5)) / aRes;
    return octDecode(uv);
}

const boundsMin = vec3<f32>(-12.0, -0.5, -12.0);
const boundsMax = vec3<f32>(12.0, 8.0, 12.0);

// Proper bounding so probes don't drift into empty space!
fn worldToGrid(level: u32, pos: vec3<f32>) -> vec3<i32> {
    let f = clamp((pos - boundsMin) / (boundsMax - boundsMin), vec3(0.0), vec3(1.0));
    let t = getGridRes(level);
    return vec3<i32>(clamp(f * t, vec3(0.0), t - 1.0));
}

fn gridToWorld(level: u32, gridPos: vec3<i32>) -> vec3<f32> {
    let f = (vec3<f32>(gridPos) + vec3<f32>(0.5)) / getGridRes(level);
    return boundsMin + f * (boundsMax - boundsMin);
}

// 5D Sannikov Trilinear + Bilinear Interpolation
fn sampleCascade_5D(level: u32, pos: vec3<f32>, dir: vec3<f32>) -> vec3<f32> {
    let tRes = getGridRes(level);
    let fpos = clamp((pos - boundsMin) / (boundsMax - boundsMin), vec3(0.0), vec3(1.0)) * tRes - 0.5;
    let basePos = vec3<i32>(floor(fpos));
    let fPosW = fract(fpos);

    let aRes = getAngRes(level);
    let uv = octEncode(dir);
    let f_aID = uv * aRes - 0.5;
    let baseA = vec2<i32>(floor(f_aID));
    let fAngW = fract(f_aID);

    var res = vec3<f32>(0.0);
    
    // Spatial Loop
    for (var z = 0i; z < 2i; z++) {
        for (var y = 0i; y < 2i; y++) {
            for (var x = 0i; x < 2i; x++) {
                let g = basePos + vec3<i32>(x, y, z);
                let xw = select(1.0 - fPosW.x, fPosW.x, x == 1i);
                let yw = select(1.0 - fPosW.y, fPosW.y, y == 1i);
                let zw = select(1.0 - fPosW.z, fPosW.z, z == 1i);
                let wPos = xw * yw * zw;
                
                var angRes = vec3<f32>(0.0);
                
                // Angular Loop
                for (var ay = 0i; ay < 2i; ay++) {
                    for (var ax = 0i; ax < 2i; ax++) {
                        let aId = baseA + vec2<i32>(ax, ay);
                        let awX = select(1.0 - fAngW.x, fAngW.x, ax == 1i);
                        let awY = select(1.0 - fAngW.y, fAngW.y, ay == 1i);
                        let wAng = awX * awY;
                        
                        let idx = getProbeIndexSafe(level, g, aId);
                        angRes += cascadeProbes[idx].rgb * wAng;
                    }
                }
                res += angRes * wPos;
            }
        }
    }
    return res;
}

fn samplePrevCascade_5D(level: u32, pos: vec3<f32>, dir: vec3<f32>) -> vec3<f32> {
    let tRes = getGridRes(level);
    let fpos = clamp((pos - boundsMin) / (boundsMax - boundsMin), vec3(0.0), vec3(1.0)) * tRes - 0.5;
    let basePos = vec3<i32>(floor(fpos));
    let fPosW = fract(fpos);

    let aRes = getAngRes(level);
    let uv = octEncode(dir);
    let f_aID = uv * aRes - 0.5;
    let baseA = vec2<i32>(floor(f_aID));
    let fAngW = fract(f_aID);

    var res = vec3<f32>(0.0);
    
    // Spatial Loop
    for (var z = 0i; z < 2i; z++) {
        for (var y = 0i; y < 2i; y++) {
            for (var x = 0i; x < 2i; x++) {
                let g = basePos + vec3<i32>(x, y, z);
                let xw = select(1.0 - fPosW.x, fPosW.x, x == 1i);
                let yw = select(1.0 - fPosW.y, fPosW.y, y == 1i);
                let zw = select(1.0 - fPosW.z, fPosW.z, z == 1i);
                let wPos = xw * yw * zw;
                
                var angRes = vec3<f32>(0.0);
                
                // Angular Loop
                for (var ay = 0i; ay < 2i; ay++) {
                    for (var ax = 0i; ax < 2i; ax++) {
                        let aId = baseA + vec2<i32>(ax, ay);
                        let awX = select(1.0 - fAngW.x, fAngW.x, ax == 1i);
                        let awY = select(1.0 - fAngW.y, fAngW.y, ay == 1i);
                        let wAng = awX * awY;
                        
                        let idx = getProbeIndexSafe(level, g, aId);
                        angRes += prevCascadeProbes[idx].rgb * wAng;
                    }
                }
                res += angRes * wPos;
            }
        }
    }
    return res;
}

fn compute_level(level: u32, gridPos: vec3<i32>, angID: vec2<i32>) {
    let rayOrigin = gridToWorld(level, gridPos);
    let rayDir = getDir(level, angID);
    
    let base_len = 0.5; // d_0 spacing
    let l_max = select(base_len * exp2(f32(level)), 1000.0, level == 3u); // C3 traces to infinity to avoid light cutoff
    
    var dummyRng = 1u; // Noise-free! Dummy to satisfy worldHit signature.
    var r = Ray(rayOrigin + rayDir * 0.05, rayDir, 1.0 / (rayDir + 0.00001));
    let hit = worldHit(r, &dummyRng);
    
    var radiance = vec3<f32>(0.0);

    // Completely Deterministic Segment Ray
    if (hit.hit && hit.dist <= l_max) {
        radiance = hit.mat.emColor * hit.mat.emStrength;
        
        // GI BOUNCE via Double Buffering
        // Re-enabled, but now reading exclusively from PREVIOUS frame's tensor
        // to prevent instantaneous data races and explosive energy loops.
        if (hit.mat.smoothness < 0.5 && hit.mat.emStrength < 0.001) {
             let albedo = hit.mat.color;
             let bounceRad = samplePrevCascade_5D(0u, hit.point + hit.normal * 0.1, hit.normal);
             // Pure conservation of energy: albedo * bounceRad must be < 1.0 to avoid nuclear explosion.
             radiance += albedo * bounceRad;
        }
    } else {
        if (level < 3u) {
            // MERGE: Sample Next Cascade at the Ray Endpoint to prevent volumetric wall bleeding
            let shiftPos = rayOrigin + rayDir * l_max;
            radiance = sampleCascade_5D(level + 1u, shiftPos, rayDir);
        } else {
            // Out of cascades - capture infinite environment
            radiance = getSkyColor(r);
        }
    }
    
    let idx = getProbeIndexSafe(level, gridPos, angID);
    let current = cascadeProbes[idx].rgb;
    
    // Fast integration, 100% stable since math is deterministic
    // Automatically apply 100% replacement during motion (frame 0) to prevent voxel ghosting/smears.
    let blendRate = select(0.3, 1.0, cam.resFovFrame.w < 1.0);
    cascadeProbes[idx] = vec4<f32>(mix(current, radiance, blendRate), 1.0);
}

@compute @workgroup_size(64) fn compute_C3(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= 1024u * 64u) { return; } // 65536
    let aRes = vec2<i32>(32); let numAng = 1024i; let gridRes = vec3<i32>(4);
    let gLinear = i32(gid.x) / numAng; let aLinear = i32(gid.x) % numAng;
    let gridPos = vec3<i32>(gLinear % gridRes.x, (gLinear / gridRes.x) % gridRes.y, gLinear / (gridRes.x * gridRes.y));
    let angID = vec2<i32>(aLinear % aRes.x, aLinear / aRes.x);
    compute_level(3u, gridPos, angID);
}

@compute @workgroup_size(64) fn compute_C2(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= 2048u * 64u) { return; } // 131072
    let aRes = vec2<i32>(16); let numAng = 256i; let gridRes = vec3<i32>(8);
    let gLinear = i32(gid.x) / numAng; let aLinear = i32(gid.x) % numAng;
    let gridPos = vec3<i32>(gLinear % gridRes.x, (gLinear / gridRes.x) % gridRes.y, gLinear / (gridRes.x * gridRes.y));
    let angID = vec2<i32>(aLinear % aRes.x, aLinear / aRes.x);
    compute_level(2u, gridPos, angID);
}

@compute @workgroup_size(64) fn compute_C1(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= 4096u * 64u) { return; } // 262144
    let aRes = vec2<i32>(8); let numAng = 64i; let gridRes = vec3<i32>(16);
    let gLinear = i32(gid.x) / numAng; let aLinear = i32(gid.x) % numAng;
    let gridPos = vec3<i32>(gLinear % gridRes.x, (gLinear / gridRes.x) % gridRes.y, gLinear / (gridRes.x * gridRes.y));
    let angID = vec2<i32>(aLinear % aRes.x, aLinear / aRes.x);
    compute_level(1u, gridPos, angID);
}

@compute @workgroup_size(64) fn compute_C0(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= 8192u * 64u) { return; } // 524288
    let aRes = vec2<i32>(4); let numAng = 16i; let gridRes = vec3<i32>(32);
    let gLinear = i32(gid.x) / numAng; let aLinear = i32(gid.x) % numAng;
    let gridPos = vec3<i32>(gLinear % gridRes.x, (gLinear / gridRes.x) % gridRes.y, gLinear / (gridRes.x * gridRes.y));
    let angID = vec2<i32>(aLinear % aRes.x, aLinear / aRes.x);
    compute_level(0u, gridPos, angID);
}

// -------------------------------------------------------------------------------------------------
// RESOLVE PASS (Fragment)

@group(1) @binding(0) var prevTex: texture_2d<f32>;
@group(1) @binding(1) var gbPos: texture_2d<f32>;
@group(1) @binding(2) var gbNormal: texture_2d<f32>;
@group(1) @binding(3) var gbAlbedo: texture_2d<f32>;
@group(1) @binding(4) var gbMotion: texture_2d<f32>;

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    var pos = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    return vec4<f32>(pos[vi], 0.0, 1.0);
}

@fragment fn fs_main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let coord = vec2<i32>(pos.xy);
    let gb_a = textureLoad(gbAlbedo, coord, 0);
    
    let globalFrame = cam.extra.x;
    var rngState = (u32(pos.x) * 1973u + u32(pos.y) * 9277u + u32(globalFrame) * 26699u) | 1u;
    
    // Add subpixel jitter for Temporal Anti-Aliasing (TAA) ONLY when accumulating
    // During motion (frame 0), jitter causes visible pixel dancing for 1-spp renders.
    let doJitter = select(0.0, 1.0, cam.resFovFrame.w > 0.0);
    let jitter = vec2<f32>(rand_float(&rngState)-0.5, rand_float(&rngState)-0.5) * doJitter;
    
    let randDisk = rand_in_unit_disk(&rngState) * (cam.dof.x * doJitter);
    var primaryRay = get_camera_ray(pos.xy, jitter, randDisk);
    let dirToScreen = primaryRay.dir;
    
    if (gb_a.a < -0.5) { 
        return vec4<f32>(getSkyColor(primaryRay), 1.0);
    }
    
    var primaryHit = worldHit(primaryRay, &rngState);
    
    var isGlass = false;
    var glassRefRad = vec3<f32>(0.0);
    var glassF = 0.0;
    var glassTintAcc = vec3<f32>(1.0);

    // Iterative Ray Bouncing for Glass Refraction (Max 4 bounces to pass completely through objects)
    for (var b = 0u; b < 4u; b++) {
        if (primaryHit.hit && primaryHit.mat.trans > 0.5) {
            if (!isGlass) {
                // First hit sets the environmental geometric reflection for the glass surface
                isGlass = true;
                let viewDir = normalize(cam.pos.xyz - primaryHit.point);
                let cosTheta = max(dot(viewDir, primaryHit.normal), 0.0);
                let F0 = vec3<f32>(0.04);
                glassF = (F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0)).x;
                
                let refDir = reflect(-viewDir, primaryHit.normal);
                var refRay = Ray(primaryHit.point + primaryHit.normal * 0.02, refDir, 1.0/(refDir + 0.00001));
                let refHitGlass = worldHit(refRay, &rngState);
                
                if (refHitGlass.hit) {
                    glassRefRad = refHitGlass.mat.emColor * refHitGlass.mat.emStrength * cam.giData.x;
                    if (refHitGlass.mat.emStrength < 0.001) {
                        glassRefRad += refHitGlass.mat.color * sampleCascade_5D(0u, refHitGlass.point + refHitGlass.normal * 0.1, refHitGlass.normal) * 1.5 * cam.giData.x;
                    }
                } else {
                    glassRefRad = getSkyColor(refRay);
                }
            }
            
            // Accumulate volumetric tint absorption
            glassTintAcc *= primaryHit.mat.color;
            
            // Calculate Refraction vector
            let ior = primaryHit.mat.ior;
            let front_face = dot(primaryRay.dir, primaryHit.normal) < 0.0;
            let outwardNormal = select(-primaryHit.normal, primaryHit.normal, front_face);
            let refraction_ratio = select(ior, 1.0/ior, front_face);
            
            // Total Internal Reflection check
            let cos_theta = min(dot(-primaryRay.dir, outwardNormal), 1.0);
            let sin_theta = sqrt(1.0 - cos_theta * cos_theta);
            var nextDir = vec3<f32>(0.0);
            
            if (refraction_ratio * sin_theta > 1.0) {
                // TIR: Reflect internally
                nextDir = reflect(primaryRay.dir, outwardNormal);
            } else {
                nextDir = refract(primaryRay.dir, outwardNormal, refraction_ratio);
            }
            
            // Advance ray through the volume
            primaryRay.origin = primaryHit.point - outwardNormal * 0.02;
            primaryRay.dir = nextDir;
            primaryRay.invDir = 1.0 / (nextDir + 0.00001);
            
            primaryHit = worldHit(primaryRay, &rngState);
        } else {
            break; // Ray exited all glass and hit a solid, or hit the sky
        }
    }
    
    if (!primaryHit.hit) {
        var finalColor = getSkyColor(primaryRay);
        if (isGlass) { finalColor = mix(finalColor * glassTintAcc, glassRefRad, glassF); }
        return vec4<f32>(finalColor, 1.0);
    }
    
    let wPos = primaryHit.point;
    let n = primaryHit.normal;
    let albedo = primaryHit.mat.color;
    
    // Evaluate pure C0 Tensor coupled with smoothly dithered Near-Field Tracing (Cascade -1)
    var indirect = vec3<f32>(0.0);
    var specularIndirect = vec3<f32>(0.0); // Deterministic specular tracking
    let viewDir = normalize(cam.pos.xyz - wPos);
    let specPower = exp2(10.0 * primaryHit.mat.smoothness + 1.0);
    
    // Completely NOISE-FREE deterministic angular evaluation
    let numSamples = 16u; 
    let golden = 2.3999632;
    var weightSum = 0.0;
    
    for (var i = 0u; i < numSamples; i++) {
        let f = (f32(i) + 0.5) / f32(numSamples);
        let theta = acos(1.0 - 2.0 * f);
        let phi = f32(i) * golden;
        let localDir = vec3<f32>(sin(theta)*cos(phi), sin(theta)*sin(phi), cos(theta));
        
        let up = select(vec3<f32>(1.0,0.0,0.0), vec3<f32>(0.0,1.0,0.0), abs(n.y) < 0.99);
        let tx = normalize(cross(up, n));
        let ty = normalize(cross(n, tx));
        let dir = normalize(tx * localDir.x + ty * localDir.y + n * abs(localDir.z));
        
        let weight = max(0.0, dot(dir, n));
        let rayOrigin = wPos + n * 0.02;
        
        var r = Ray(rayOrigin, dir, 1.0 / (dir + 0.00001));
        let hit = worldHit(r, &rngState);
        
        let base_len = 0.5; // Distance matching C_0 spacing
        var incomingRadiance = vec3<f32>(0.0);
        
        if (hit.hit && hit.dist <= base_len) {
            // Near-field high-freq logic (Deterministic Direct Hit)
            incomingRadiance = hit.mat.emColor * hit.mat.emStrength * cam.giData.x;
            // Short-range bounce using C0 tensor (Safe because fs_main is read-only)
            if (hit.mat.emStrength < 0.001) { 
                incomingRadiance += hit.mat.color * sampleCascade_5D(0u, hit.point + hit.normal * 0.1, hit.normal); 
            }
        } else {
            // Smooth, pre-integrated Far-field cascade interpolation (noise-free)
            // Shift pos to the end of the near-field trace to stop wall leaking
            incomingRadiance = sampleCascade_5D(0u, rayOrigin + dir * base_len, dir);
        }
        
        indirect += incomingRadiance * weight;
        
        // Evaluate deterministic Specular BRDF over the cascade traces for glossy materials
        if (primaryHit.mat.smoothness <= 0.9) {
            let H = normalize(viewDir + dir);
            let NdotH = max(dot(n, H), 0.0);
            let specIntensity = pow(NdotH, specPower) * primaryHit.mat.smoothness;
            specularIndirect += incomingRadiance * specIntensity * weight;
        }
        
        weightSum += weight;
    }
    
    indirect = indirect / max(weightSum, 0.0001);
    var diffuseFinal = albedo * (indirect * 1.5 * cam.giData.x);
    diffuseFinal += primaryHit.mat.emColor * primaryHit.mat.emStrength * cam.giData.x;
    
    // SPECULAR REFLECTION LOBE
    var specularFinal = vec3<f32>(0.0);
    if (primaryHit.mat.smoothness > 0.3) {
        // Noise-Free Mirror Reflection for reflective materials
        let perfectRefDir = reflect(-viewDir, primaryHit.normal);
        var refRay = Ray(primaryHit.point + primaryHit.normal * 0.02, perfectRefDir, 1.0/(perfectRefDir + 0.00001));
        let refHit = worldHit(refRay, &rngState);
        
        if (refHit.hit) {
            var refRad = refHit.mat.emColor * refHit.mat.emStrength * cam.giData.x;
            if (refHit.mat.emStrength < 0.001) {
                refRad += refHit.mat.color * sampleCascade_5D(0u, refHit.point + refHit.normal * 0.1, refHit.normal) * 1.5 * cam.giData.x;
            }
            specularFinal = refRad;
        } else {
            specularFinal = getSkyColor(refRay);
        }
        
        let cosTheta = max(dot(viewDir, primaryHit.normal), 0.0);
        let F0 = mix(vec3(0.04), primaryHit.mat.color, primaryHit.mat.metallic);
        var F = F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
        
        // Reflectivity floor: ensures polished surfaces always show visible reflections
        let smoothSq = primaryHit.mat.smoothness * primaryHit.mat.smoothness;
        F = max(F, vec3<f32>(smoothSq));
        
        // Purely ADDITIVE specular — reflections can only brighten, never darken
        diffuseFinal = diffuseFinal + F * primaryHit.mat.smoothness * specularFinal;
    }
    
    var finalColor = diffuseFinal;
    
    if (isGlass) {
        finalColor = mix(finalColor * glassTintAcc, glassRefRad, glassF);
    }
    if (cam.resFovFrame.w > 0.0) {
        let prevColor = textureLoad(prevTex, coord, 0).rgb;
        finalColor = mix(prevColor, finalColor, 1.0 / min(cam.resFovFrame.w + 1.0, 30.0));
    }
    
    return vec4<f32>(finalColor, 1.0);
}
