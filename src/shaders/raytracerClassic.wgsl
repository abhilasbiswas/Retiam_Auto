
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
            