
                @group(1) @binding(0) var prevTex: texture_2d<f32>;
                @group(1) @binding(1) var gbPos: texture_2d<f32>;
                @group(1) @binding(2) var gbNormal: texture_2d<f32>;
                @group(1) @binding(3) var gbAlbedo: texture_2d<f32>;
                @group(1) @binding(4) var gbMotion: texture_2d<f32>;
                @group(1) @binding(5) var<storage, read_write> resCurr: array<Reservoir>;
                @group(1) @binding(6) var<storage, read> resPrev: array<Reservoir>;

                fn trace_bounces(initial_ray: Ray, rngState: ptr<function, u32>) -> vec3<f32> {
    var ray        = initial_ray;
    var throughput = vec3<f32>(1.0);
    var L          = vec3<f32>(0.0);
    let max_bounces = i32(cam.dof.z);

    for (var bounce = 0; bounce < max_bounces; bounce++) {
        let hit = worldHit(ray, rngState);
        if (!hit.hit) { L += throughput * getSkyColor(ray); break; }
        L += throughput * (hit.mat.emColor * hit.mat.emStrength);
        if (!bsdf_scatter(&ray, hit, rngState, &throughput)) { break; }
    }
    return L;
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
        return evaluateFallbackShading(gb_p, gb_n, gb_a, cameraRay.origin, dirToScreen, metallic, &rngState);
    }

    var totalColor = vec3<f32>(0.0);
    let pixel_idx = u32(coord.y) * u32(cam.resFovFrame.x) + u32(coord.x);
    var r: Reservoir;
    r.y_point = vec4<f32>(0.0); r.y_normal = vec4<f32>(0.0); r.y_radiance = vec4<f32>(0.0, 0.0, 0.0, bitcast<f32>(0u));

    if (gb_a.a < -0.5) { 
        totalColor = getSkyColor(cameraRay);
    } else {
        let hitPoint  = gb_p.xyz;
        let hitNormal = normalize(gb_n.xyz);
        let roughness = gb_n.w;         // was smoothness
        let albedo    = gb_a.rgb;
        let trans     = gb_p.w;

        // Build a minimal Material from G-Buffer data for eval_bsdf()
        var gbMat: Material;
        gbMat.color        = albedo;
        gbMat.roughness    = roughness;
        gbMat.metallic     = metallic;
        gbMat.specular     = 0.5;       // physical default
        gbMat.emColor      = vec3<f32>(0.0);
        gbMat.emStrength   = 0.0;
        gbMat.transmission = 0.0;
        gbMat.ior          = 1.5;
        gbMat.opacity      = 1.0;

        if (gb_a.a > 0.0) { totalColor += albedo; }

        if (rand_float(&rngState) < trans) {
            var bounceRay = Ray(hitPoint + dirToScreen * 0.001, dirToScreen, 1.0 / dirToScreen);
            totalColor += trace_bounces(bounceRay, &rngState);
        } else {
            var bounceRay = Ray(hitPoint, vec3(0.0), vec3(0.0));
            var pdf = 1.0;

            // F0 for G-buffer material — matches bsdf_scatter_opaque path selection
            let F0_scalar = F0_from_ior(gbMat.ior, gbMat.specular);
            let F0_vec    = mix(vec3<f32>(F0_scalar), gbMat.color, gbMat.metallic);
            let F_view    = fresnel_schlick(max(dot(hitNormal, V), 0.0), F0_vec);
            let p_spec    = clamp(dot(F_view, vec3<f32>(0.2126, 0.7152, 0.0722)), 0.01, 0.99);

            if (rand_float(&rngState) < p_spec) {
                // alpha = roughness^2 (matches brdf.wgsl convention)
                let alpha = max(roughness * roughness, 0.001);
                let H = sample_GGX_halfvector(hitNormal, alpha, &rngState);
                bounceRay.dir = reflect(-V, H);
                pdf = max(p_spec, 0.001);
            } else {
                bounceRay.dir = normalize(hitNormal + rand_unit_vector(&rngState));
                pdf = max(1.0 - p_spec, 0.001);
            }
            
            bounceRay.origin = hitPoint + hitNormal * 0.001 + bounceRay.dir * 0.002;
            bounceRay.invDir = 1.0 / bounceRay.dir;

            var incomingLight = vec3<f32>(0.0);
            if (dot(bounceRay.dir, hitNormal) > 0.0) {
                incomingLight = trace_bounces(bounceRay, &rngState) * cam.giData.x;
            }

            // eval_bsdf from brdf.wgsl — energy-correct BRDF evaluation for reservoir weighting
            let contrib = eval_bsdf(bounceRay.dir, V, hitNormal, gbMat);
            let p_hat   = dot(contrib, vec3<f32>(0.2126, 0.7152, 0.0722));
            let weight  = p_hat / pdf;
            updateReservoir(&r, vec4<f32>(bounceRay.dir, 0.0), vec4<f32>(albedo, 0.0), incomingLight, weight, &rngState);

            if (frameCount > 0.0) {
                let unjittered_uv = pos.xy / cam.resFovFrame.xy;
                let prev_coord = vec2<i32>((unjittered_uv - gb_m) * cam.resFovFrame.xy);
                if (prev_coord.x >= 0 && prev_coord.x < i32(cam.resFovFrame.x) && prev_coord.y >= 0 && prev_coord.y < i32(cam.resFovFrame.y)) {
                    var prev_r = resPrev[u32(prev_coord.y) * u32(cam.resFovFrame.x) + u32(prev_coord.x)];
                    prev_r.y_radiance.w = bitcast<f32>(min(bitcast<u32>(prev_r.y_radiance.w), 15u));
                    let temp_contrib = eval_bsdf(prev_r.y_point.xyz, V, hitNormal, gbMat);
                    mergeReservoir(&r, prev_r, dot(temp_contrib, vec3<f32>(0.2126, 0.7152, 0.0722)), &rngState);
                }
            }

            // Spatial reuse — eval_bsdf for neighbor contribution
            if (frameCount > 0.0) {
                for (var i = 0; i < i32(samples); i++) { 
                    let neighbor_coord = coord + vec2<i32>(rand_in_unit_disk(&rngState) * 12.0);
                    if (neighbor_coord.x >= 0 && neighbor_coord.x < i32(cam.resFovFrame.x) && neighbor_coord.y >= 0 && neighbor_coord.y < i32(cam.resFovFrame.y)) {
                        let n_p = textureLoad(gbPos, neighbor_coord, 0).xyz;
                        let n_n = textureLoad(gbNormal, neighbor_coord, 0).xyz;
                        var n_r = resPrev[u32(neighbor_coord.y) * u32(cam.resFovFrame.x) + u32(neighbor_coord.x)];
                        
                        if (dot(n_n, hitNormal) > 0.9 && distance(n_p, hitPoint) < 0.2) {
                            n_r.y_radiance.w = bitcast<f32>(min(bitcast<u32>(n_r.y_radiance.w), 4u)); 
                            let spat_contrib = eval_bsdf(n_r.y_point.xyz, V, hitNormal, gbMat);
                            mergeReservoir(&r, n_r, dot(spat_contrib, vec3<f32>(0.2126, 0.7152, 0.0722)), &rngState);
                        }
                    }
                }
            }

            let final_contrib = eval_bsdf(r.y_point.xyz, V, hitNormal, gbMat);
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
            