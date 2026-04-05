
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
            