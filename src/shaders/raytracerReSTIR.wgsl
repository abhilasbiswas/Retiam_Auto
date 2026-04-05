
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
            