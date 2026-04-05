
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
            