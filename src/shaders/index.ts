import common          from './common.wgsl?raw';
import brdf            from './brdf.wgsl?raw';       // PBR BSDF module — shared by all RT shaders
import gbuffer         from './gbuffer.wgsl?raw';
import raytracerReSTIR  from './raytracerReSTIR.wgsl?raw';
import raytracerClassic from './raytracerClassic.wgsl?raw';
import radianceCascades from './radianceCascades.wgsl?raw';
import screen          from './screen.wgsl?raw';
import refitCompute    from './refitCompute.wgsl?raw';
import lbvh_compute    from './lbvh_compute.wgsl?raw';

// common + brdf = shared base for all path-tracing shaders
const rtBase = common + brdf;

export const shaders = {
    gbuffer:           rtBase + gbuffer,
    raytracerReSTIR:   rtBase + raytracerReSTIR,
    raytracerClassic:  rtBase + raytracerClassic,
    radianceCascades:  rtBase + radianceCascades,
    screen:            screen,
    refitCompute:      refitCompute,
    lbvh_compute:      rtBase + lbvh_compute,
};

