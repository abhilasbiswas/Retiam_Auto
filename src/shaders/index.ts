import common from './common.wgsl?raw';
import gbuffer from './gbuffer.wgsl?raw';
import raytracerReSTIR from './raytracerReSTIR.wgsl?raw';
import raytracerClassic from './raytracerClassic.wgsl?raw';
import screen from './screen.wgsl?raw';
import refitCompute from './refitCompute.wgsl?raw';
import lbvh_compute from './lbvh_compute.wgsl?raw';

export const shaders = {
    gbuffer: common + gbuffer,
    raytracerReSTIR: common + raytracerReSTIR,
    raytracerClassic: common + raytracerClassic,
    screen: screen,
    refitCompute: refitCompute,
    lbvh_compute: common + lbvh_compute
};
