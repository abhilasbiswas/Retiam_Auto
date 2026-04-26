
                @group(1) @binding(0) var prevTex: texture_2d<f32>;
                // Include bindings so PipelineLayout identically matches ReSTIR's requirements
                @group(1) @binding(1) var gbPos: texture_2d<f32>;
                @group(1) @binding(2) var gbNormal: texture_2d<f32>;
                @group(1) @binding(3) var gbAlbedo: texture_2d<f32>;
                @group(1) @binding(4) var gbMotion: texture_2d<f32>;
                @group(1) @binding(5) var<storage, read_write> resCurr: array<Reservoir>;
                @group(1) @binding(6) var<storage, read> resPrev: array<Reservoir>;

                fn trace_classic(initial_ray: Ray, rngState: ptr<function, u32>) -> vec3<f32> {
    var ray        = initial_ray;
    var throughput = vec3<f32>(1.0);
    var L          = vec3<f32>(0.0);
    let max_bounces = i32(cam.dof.z);

    for (var bounce = 0; bounce < max_bounces; bounce++) {
        let hit = worldHit(ray, rngState);
        let gi_mult = select(cam.giData.x, 1.0, bounce == 0);

        if (!hit.hit) {
            L += throughput * getSkyColor(ray) * gi_mult;
            break;
        }

        // Emission contribution
        L += throughput * (hit.mat.emColor * hit.mat.emStrength) * gi_mult;

        // bsdf_scatter() from brdf.wgsl handles:
        //   - Stochastic opacity (cutout alpha)
        //   - Transmission (glass) with correct Schlick Fresnel + Snell refraction
        //   - Opaque: energy-conserving GGX specular + Lambertian diffuse
        // Returns false if throughput drops below 0.001 (ray absorbed)
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
    let globalFrame = cam.extra.x;
    var rngState = (u32(pos.x) * 1973u + u32(pos.y) * 9277u + u32(globalFrame) * 26699u) | 1u;

    let cameraRay = get_camera_ray(pos.xy, vec2(0.0), vec2(0.0));
    let dirToScreen = cameraRay.dir;

    if (rt_enabled < 0.5) {
        let gb_p = textureLoad(gbPos, coord, 0);
        let gb_n = textureLoad(gbNormal, coord, 0);
        let gb_a = textureLoad(gbAlbedo, coord, 0);
        let gb_m_full = textureLoad(gbMotion, coord, 0);
        return evaluateFallbackShading(gb_p, gb_n, gb_a, cameraRay.origin, dirToScreen, gb_m_full.z, &rngState);
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
            