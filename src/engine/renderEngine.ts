// @ts-nocheck
import { Math3D } from '../math/math3d';
import { OIDNManager } from '../gpu/oidnManager';
import { CameraController } from './camera';
import { shaders } from '../shaders/index';
import { GPUArena } from '../gpu/arena';
import { createSDFTexture } from '../geometry/sdfTexture';
import { computeWorldAABB } from '../math/math3d';
import { buildMeshBVH } from '../geometry/bvhBuilder';

export             class RenderEngine {
                constructor(canvas) {
                    this.canvas = canvas;
                    this.width = 1280; this.height = 720;
                    this.canvas.width = this.width; this.canvas.height = this.height;

                    this.camData = new Float32Array(56);

                    this.useScissor = false;
                    this.tileRect = null;
                    this.rtTechnique = 0; // Default to Classic
                }


                async init() {
                    if (!navigator.gpu) throw new Error("WebGPU not supported.");
                    this.adapter = await navigator.gpu.requestAdapter();

                    const requiredLimits = {
                        maxStorageBufferBindingSize: this.adapter.limits.maxStorageBufferBindingSize,
                        maxBufferSize: this.adapter.limits.maxBufferSize,
                        maxComputeWorkgroupStorageSize: this.adapter.limits.maxComputeWorkgroupStorageSize,
                    };
                    if (this.adapter.limits.maxColorAttachmentBytesPerSample > 32) {
                        requiredLimits.maxColorAttachmentBytesPerSample = this.adapter.limits.maxColorAttachmentBytesPerSample;
                    }

                    this.device = await this.adapter.requestDevice({ requiredLimits });
                    this.context = this.canvas.getContext('webgpu');
                    this.presentationFormat = navigator.gpu.getPreferredCanvasFormat();
                    this.context.configure({ device: this.device, format: this.presentationFormat });

                    this.setupCoreBuffers();
                    this.setupResolutionDependentBuffers();
                    this.msdfTexture = createSDFTexture(this.device);
                    await this.setupPipelines();
                }
                setupCoreBuffers() {
                    this.linearSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });

                    const storageUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;

                    // Lightweight startup capacities! 
                    // Triangles: 50,000 * 96b = ~4.8 MB
                    // BVH Nodes: 100,000 * 48b = ~4.8 MB
                    this.sphereArena = new GPUArena(this.device, "Spheres", 1000, 80, storageUsage);
                    this.meshArena = new GPUArena(this.device, "Meshes", 1000, 288, storageUsage);
                    this.triangleArena = new GPUArena(this.device, "Triangles", 50000, 96, storageUsage);
                    this.bvhArena = new GPUArena(this.device, "BVHNodes", 100000, 48, storageUsage);

                    this.mortonArena = new GPUArena(this.device, "Morton", 50000, 8, storageUsage | GPUBufferUsage.COPY_SRC);
                    this.flagsArena = new GPUArena(this.device, "BVHFlags", 100000, 4, storageUsage);

                    // ... rest of the buffers
                    this.cameraBuffer = this.device.createBuffer({ size: 224, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
                    this.postProcBuffer = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
                    this.vectorTexture = this.device.createTexture({ size: [2048, 2048, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });

                    this.lbvhSceneBoundsBuffer = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
                    this.lbvhBuildParamsBuffer = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
                    this.lbvhSortParamsBuffer = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

                    this.MAX_TEXTURE_LAYERS = 64;
                    this.TEX_SIZE = 1024;

                    // ADDED RENDER_ATTACHMENT HERE
                    this.albedoTexArray = this.device.createTexture({
                        size: [this.TEX_SIZE, this.TEX_SIZE, this.MAX_TEXTURE_LAYERS],
                        format: 'rgba8unorm',
                        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
                    });

                    // ADDED RENDER_ATTACHMENT HERE
                    this.normalTexArray = this.device.createTexture({
                        size: [this.TEX_SIZE, this.TEX_SIZE, this.MAX_TEXTURE_LAYERS],
                        format: 'rgba8unorm',
                        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
                    });
                }


                async loadMeshesTextures(mobjects) {
                    const albedoUrls = [...new Set(mobjects.map(m => m.albedoUrl).filter(url => url))];
                    const normalUrls = [...new Set(mobjects.map(m => m.normalUrl).filter(url => url))];

                    const maxRequiredLayers = Math.max(albedoUrls.length, normalUrls.length, 1);

                    // Dynamically expand Texture Arrays if needed
                    if (maxRequiredLayers > this.MAX_TEXTURE_LAYERS) {
                        this.MAX_TEXTURE_LAYERS = Math.ceil(maxRequiredLayers * 1.5);
                        console.log(`[Arena] Expanding Texture Array Layers to ${this.MAX_TEXTURE_LAYERS}`);

                        if (this.albedoTexArray) this.albedoTexArray.destroy();
                        if (this.normalTexArray) this.normalTexArray.destroy();

                        // ADDED RENDER_ATTACHMENT HERE
                        this.albedoTexArray = this.device.createTexture({
                            size: [this.TEX_SIZE, this.TEX_SIZE, this.MAX_TEXTURE_LAYERS],
                            format: 'rgba8unorm',
                            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
                        });

                        // ADDED RENDER_ATTACHMENT HERE
                        this.normalTexArray = this.device.createTexture({
                            size: [this.TEX_SIZE, this.TEX_SIZE, this.MAX_TEXTURE_LAYERS],
                            format: 'rgba8unorm',
                            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
                        });

                        if (this.bgLayout0) this.updateBindGroups();
                    }


                    const uploadToLayer = async (urls, targetTexture) => {
                        for (let i = 0; i < urls.length; i++) {
                            try {
                                const response = await fetch(urls[i]);
                                const blob = await response.blob();
                                const imageBitmap = await createImageBitmap(blob, { resizeWidth: this.TEX_SIZE, resizeHeight: this.TEX_SIZE });

                                this.device.queue.copyExternalImageToTexture(
                                    { source: imageBitmap },
                                    { texture: targetTexture, origin: [0, 0, i] }, [this.TEX_SIZE, this.TEX_SIZE]
                                );
                            } catch (e) { console.warn("Failed to load texture:", urls[i], e); }
                        }
                    };

                    await Promise.all([
                        uploadToLayer(albedoUrls, this.albedoTexArray),
                        uploadToLayer(normalUrls, this.normalTexArray)
                    ]);

                    mobjects.forEach(m => {
                        if (m.triangles) {
                            m.albedoTexIdx = m.albedoUrl ? albedoUrls.indexOf(m.albedoUrl) : -1.0;
                            m.normalTexIdx = m.normalUrl ? normalUrls.indexOf(m.normalUrl) : -1.0;
                        }
                    });
                }


                setupResolutionDependentBuffers() {
                    const texDesc = { size: [this.width, this.height, 1], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING };
                    this.texA = this.device.createTexture(texDesc); this.texB = this.device.createTexture(texDesc);

                    this.readTexture = this.device.createTexture({ size: [this.width, this.height, 1], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
                    this.bytesPerRow = Math.ceil((this.width * 4) / 256) * 256;
                    this.readBuffer = this.device.createBuffer({ size: this.bytesPerRow * this.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

                    const gBufferUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
                    this.gBufferPos = this.device.createTexture({ size: [this.width, this.height, 1], format: 'rgba32float', usage: gBufferUsage });
                    this.gBufferNormal = this.device.createTexture({ size: [this.width, this.height, 1], format: 'rgba16float', usage: gBufferUsage });
                    this.gBufferAlbedo = this.device.createTexture({ size: [this.width, this.height, 1], format: 'rgba16float', usage: gBufferUsage });
                    this.gBufferMotion = this.device.createTexture({ size: [this.width, this.height, 1], format: 'rgba16float', usage: gBufferUsage });
                    const reservoirSize = this.width * this.height * 48;
                    this.reservoirA = this.device.createBuffer({ size: reservoirSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
                    this.reservoirB = this.device.createBuffer({ size: reservoirSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
                    this.reservoirSpatial = this.device.createBuffer({ size: reservoirSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

                    const numPixels = this.width * this.height;
                    this.oidnColorBuf = this.device.createBuffer({
                        size: numPixels * 16,
                        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
                    });
                    
                    // --- ADD THESE TWO BUFFERS ---
                    this.oidnAlbedoBuf = this.device.createBuffer({
                        size: numPixels * 16,
                        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
                    });
                    this.oidnNormalBuf = this.device.createBuffer({
                        size: numPixels * 16,
                        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
                    });

                    this.oidnReadBuf = this.device.createBuffer({ size: numPixels * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                    this.oidnTexture = this.device.createTexture({ size: [this.width, this.height, 1], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
                }

                resize(newWidth, newHeight) {
                    if (this.width === newWidth && this.height === newHeight) return;
                    this.width = newWidth; this.height = newHeight;
                    this.canvas.width = newWidth; this.canvas.height = newHeight;
                    this.setupResolutionDependentBuffers();
                    this.updateBindGroups();
                }

                async setupPipelines() {
                    const rtModuleReSTIR = this.device.createShaderModule({ code: shaders.raytracerReSTIR });
                    const rtModuleClassic = this.device.createShaderModule({ code: shaders.raytracerClassic });
                    const screenModule = this.device.createShaderModule({ code: shaders.screen });
                    const refitModule = this.device.createShaderModule({ code: shaders.refitCompute });
                    const gBufferModule = this.device.createShaderModule({ code: shaders.gbuffer });
                    const lbvhModule = this.device.createShaderModule({ code: shaders.lbvh_compute });

                    const oidnExtractWgsl = `
                    @group(0) @binding(0) var texColor: texture_2d<f32>;
                    @group(0) @binding(1) var<storage, read_write> colorBuf: array<vec4<f32>>;
                    
                    @group(0) @binding(2) var texAlbedo: texture_2d<f32>;
                    @group(0) @binding(3) var<storage, read_write> albedoBuf: array<vec4<f32>>;
                    
                    @group(0) @binding(4) var texNormal: texture_2d<f32>;
                    @group(0) @binding(5) var<storage, read_write> normalBuf: array<vec4<f32>>;

                    @compute @workgroup_size(8, 8)
                    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
                        let dim = textureDimensions(texColor);
                        if (id.x >= dim.x || id.y >= dim.y) { return; }
                        
                        let coord = vec2<i32>(id.xy);
                        let idx = id.y * dim.x + id.x;
                        
                        // 1. Extract Color
                        colorBuf[idx] = textureLoad(texColor, coord, 0);
                        
                        // 2. Extract Albedo (Clamped to 1.0 to remove Emissive HDR values, which confuse OIDN)
                        let alb = textureLoad(texAlbedo, coord, 0).rgb;
                        albedoBuf[idx] = vec4<f32>(clamp(alb, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
                        
                        // 3. Extract Normal (Already in the [-1.0, 1.0] range required by OIDN)
                        let norm = textureLoad(texNormal, coord, 0).xyz;
                        normalBuf[idx] = vec4<f32>(norm, 1.0)*0.5 + 0.5;
                    }
                `;
                    const oidnInjectWgsl = `
                    @group(0) @binding(0) var<storage, read> inBuf: array<vec4<f32>>;
                    @group(0) @binding(1) var outTex: texture_storage_2d<rgba32float, write>;
                    @compute @workgroup_size(8, 8)
                    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
                        let dim = textureDimensions(outTex);
                        if (id.x >= dim.x || id.y >= dim.y) { return; }
                        textureStore(outTex, vec2<i32>(id.xy), inBuf[id.y * dim.x + id.x]);
                    }
                `;
                    this.oidnExtractModule = this.device.createShaderModule({ code: oidnExtractWgsl });
                    this.oidnExtractPipeline = await this.device.createComputePipelineAsync({ layout: 'auto', compute: { module: this.oidnExtractModule, entryPoint: 'main' } });
                    this.oidnInjectModule = this.device.createShaderModule({ code: oidnInjectWgsl });
                    this.oidnInjectPipeline = await this.device.createComputePipelineAsync({ layout: 'auto', compute: { module: this.oidnInjectModule, entryPoint: 'main' } });

                    this.bgLayout0 = this.device.createBindGroupLayout({
                        entries: [
                            { binding: 0, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                            { binding: 1, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                            { binding: 2, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                            { binding: 3, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                            { binding: 4, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                            { binding: 5, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
                            { binding: 6, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
                            { binding: 7, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
                            { binding: 8, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d-array' } },
                            { binding: 9, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d-array' } }
                        ]
                    });

                    this.bgLayout1 = this.device.createBindGroupLayout({
                        entries: [
                            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
                            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
                            { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
                            { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
                            { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
                            { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'storage' } },
                            { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }
                        ]
                    });

                    this.screenLayout = this.device.createBindGroupLayout({
                        entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }, { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }]
                    });

                    this.lbvhBgLayout = this.device.createBindGroupLayout({
                        entries: [
                            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }, { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }, { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                            { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }, { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
                        ]
                    });

                    this.gBufferPipeline = await this.device.createRenderPipelineAsync({
                        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bgLayout0] }),
                        vertex: { module: gBufferModule, entryPoint: 'vs_main' },
                        fragment: { module: gBufferModule, entryPoint: 'fs_main', targets: [{ format: 'rgba32float' }, { format: 'rgba16float' }, { format: 'rgba16float' }, { format: 'rgba16float' }] },
                        primitive: { topology: 'triangle-list' }
                    });

                    this.rtPipelineReSTIR = await this.device.createRenderPipelineAsync({
                        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bgLayout0, this.bgLayout1] }),
                        vertex: { module: rtModuleReSTIR, entryPoint: 'vs_main' }, fragment: { module: rtModuleReSTIR, entryPoint: 'fs_main', targets: [{ format: 'rgba32float' }] },
                        primitive: { topology: 'triangle-list' }
                    });

                    this.rtPipelineClassic = await this.device.createRenderPipelineAsync({
                        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bgLayout0, this.bgLayout1] }),
                        vertex: { module: rtModuleClassic, entryPoint: 'vs_main' }, fragment: { module: rtModuleClassic, entryPoint: 'fs_main', targets: [{ format: 'rgba32float' }] },
                        primitive: { topology: 'triangle-list' }
                    });

                    this.screenPipeline = await this.device.createRenderPipelineAsync({
                        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.screenLayout] }),
                        vertex: { module: screenModule, entryPoint: 'vs_main' }, fragment: { module: screenModule, entryPoint: 'fs_main', targets: [{ format: this.presentationFormat }] },
                        primitive: { topology: 'triangle-list' }
                    });

                    this.offlineScreenPipeline = await this.device.createRenderPipelineAsync({
                        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.screenLayout] }),
                        vertex: { module: screenModule, entryPoint: 'vs_main' }, fragment: { module: screenModule, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
                        primitive: { topology: 'triangle-list' }
                    });

                    this.refitPipeline = await this.device.createComputePipelineAsync({ layout: 'auto', compute: { module: refitModule, entryPoint: 'main' } });

                    const lbvhPipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bgLayout0, this.lbvhBgLayout] });
                    this.lbvhEncodePipeline = await this.device.createComputePipelineAsync({ layout: lbvhPipelineLayout, compute: { module: lbvhModule, entryPoint: 'encode_morton' } });
                    this.lbvhSortPipeline = await this.device.createComputePipelineAsync({ layout: lbvhPipelineLayout, compute: { module: lbvhModule, entryPoint: 'bitonic_sort' } });
                    this.lbvhBuildTreePipeline = await this.device.createComputePipelineAsync({ layout: lbvhPipelineLayout, compute: { module: lbvhModule, entryPoint: 'build_tree' } });
                    this.lbvhRefitPipeline = await this.device.createComputePipelineAsync({ layout: lbvhPipelineLayout, compute: { module: lbvhModule, entryPoint: 'refit_aabbs' } });

                    this.updateBindGroups();
                }
                updateBindGroups() {
                    this.bg0 = this.device.createBindGroup({
                        layout: this.bgLayout0,
                        entries: [
                            { binding: 0, resource: { buffer: this.cameraBuffer } },
                            { binding: 1, resource: { buffer: this.sphereArena.gpuBuffer } },
                            { binding: 2, resource: { buffer: this.meshArena.gpuBuffer } },
                            { binding: 3, resource: { buffer: this.triangleArena.gpuBuffer } },
                            { binding: 4, resource: { buffer: this.bvhArena.gpuBuffer } },
                            { binding: 5, resource: this.vectorTexture.createView() },
                            { binding: 6, resource: this.msdfTexture ? this.msdfTexture.createView() : this.vectorTexture.createView() },
                            { binding: 7, resource: this.linearSampler },
                            { binding: 8, resource: this.albedoTexArray.createView({ dimension: '2d-array' }) },
                            { binding: 9, resource: this.normalTexArray.createView({ dimension: '2d-array' }) }
                        ]
                    });

                    const createRTBindGroup = (historyTex, resCurr, resPrev) => {
                        return this.device.createBindGroup({
                            layout: this.bgLayout1,
                            entries: [
                                { binding: 0, resource: historyTex.createView() }, { binding: 1, resource: this.gBufferPos.createView() },
                                { binding: 2, resource: this.gBufferNormal.createView() }, { binding: 3, resource: this.gBufferAlbedo.createView() },
                                { binding: 4, resource: this.gBufferMotion.createView() }, { binding: 5, resource: { buffer: resCurr } }, { binding: 6, resource: { buffer: resPrev } }
                            ]
                        });
                    };

                    this.bg1A = createRTBindGroup(this.texA, this.reservoirB, this.reservoirA);
                    this.bg1B = createRTBindGroup(this.texB, this.reservoirA, this.reservoirB);

                    this.screenBgA = this.device.createBindGroup({ layout: this.screenLayout, entries: [{ binding: 0, resource: this.texA.createView() }, { binding: 1, resource: { buffer: this.postProcBuffer } }, { binding: 2, resource: this.oidnTexture.createView() }] });
                    this.screenBgB = this.device.createBindGroup({ layout: this.screenLayout, entries: [{ binding: 0, resource: this.texB.createView() }, { binding: 1, resource: { buffer: this.postProcBuffer } }, { binding: 2, resource: this.oidnTexture.createView() }] });

                    this.lbvhBindGroup = this.device.createBindGroup({
                        layout: this.lbvhBgLayout,
                        entries: [
                            { binding: 0, resource: { buffer: this.mortonArena.gpuBuffer } },
                            { binding: 1, resource: { buffer: this.lbvhSceneBoundsBuffer } },
                            { binding: 2, resource: { buffer: this.lbvhBuildParamsBuffer } },
                            { binding: 3, resource: { buffer: this.lbvhSortParamsBuffer } },
                            { binding: 4, resource: { buffer: this.bvhArena.gpuBuffer } },
                            { binding: 5, resource: { buffer: this.flagsArena.gpuBuffer } }
                        ]
                    });
                }
                serializeTris(tris, outDataF32, offsetFloats) {
                    let i = offsetFloats;
                    for (let t = 0; t < tris.length; t++) {
                        let tri = tris[t];
                        outDataF32[i++] = tri[0][0]; outDataF32[i++] = tri[0][1]; outDataF32[i++] = tri[0][2]; outDataF32[i++] = tri[6] ? tri[6][0] : 0;
                        outDataF32[i++] = tri[1][0]; outDataF32[i++] = tri[1][1]; outDataF32[i++] = tri[1][2]; outDataF32[i++] = tri[7] ? tri[7][0] : 0;
                        outDataF32[i++] = tri[2][0]; outDataF32[i++] = tri[2][1]; outDataF32[i++] = tri[2][2]; outDataF32[i++] = tri[8] ? tri[8][0] : 0;
                        outDataF32[i++] = tri[3][0]; outDataF32[i++] = tri[3][1]; outDataF32[i++] = tri[3][2]; outDataF32[i++] = tri[6] ? tri[6][1] : 0;
                        outDataF32[i++] = tri[4][0]; outDataF32[i++] = tri[4][1]; outDataF32[i++] = tri[4][2]; outDataF32[i++] = tri[7] ? tri[7][1] : 0;
                        outDataF32[i++] = tri[5][0]; outDataF32[i++] = tri[5][1]; outDataF32[i++] = tri[5][2]; outDataF32[i++] = tri[8] ? tri[8][1] : 0;
                    }
                }

                serializeNodes(nodes, triOffset, bvhRootOffset, outF32, outI32, outU32, offsetNodes) {
                    let i = offsetNodes * 12;
                    for (let n = 0; n < nodes.length; n++) {
                        let node = nodes[n];
                        let leftFirst = node.triCount > 0 ? (node.leftFirst + triOffset) : (node.leftFirst + bvhRootOffset);
                        let parentIdx = node.parent !== -1 ? (node.parent + bvhRootOffset) : -1;

                        outF32[i + 0] = node.min[0]; outF32[i + 1] = node.min[1]; outF32[i + 2] = node.min[2]; outU32[i + 3] = leftFirst;
                        outF32[i + 4] = node.max[0]; outF32[i + 5] = node.max[1]; outF32[i + 6] = node.max[2]; outU32[i + 7] = node.triCount;
                        outI32[i + 8] = parentIdx; outU32[i + 9] = node.triCount > 0 ? 1 : 0;
                        outU32[i + 10] = node.triCount > 0 ? 0 : leftFirst + 1;
                        i += 12;
                    }
                }
                bakeMeshes(mobjects, bvhMethod = this.bvhMethod || 'spatial') {
                    let totalTris = 0;
                    let totalNodes = 0;
                    const meshList = mobjects.filter(o => o.triangles);

                    // 1. Calculate capacity requirements
                    meshList.forEach(mesh => {
                        if (!mesh.bvh || mesh.bvhDirty) {
                            if (mesh.isMorphing) { mesh.buildMorphBVH(bvhMethod); }
                            else { mesh.bvh = buildMeshBVH(mesh.triangles, bvhMethod); }
                            mesh.bvhDirty = false;
                        }
                        totalTris += mesh.bvh.triangles.length;
                        totalNodes += mesh.bvh.nodes.length;
                    });

                    // 2. Expand Arenas if needed.
                    let rebind = false;
                    rebind |= this.triangleArena.ensureCapacity(totalTris);
                    rebind |= this.mortonArena.ensureCapacity(totalTris);
                    rebind |= this.bvhArena.ensureCapacity(totalNodes);
                    rebind |= this.flagsArena.ensureCapacity(totalNodes);

                    // ---> THE FIX: Cascade the memory refresh <---
                    if (rebind) {
                        // Update main engine bindings
                        if (this.bgLayout0) this.updateBindGroups();

                        // Force dynamic objects to rebuild their WebGPU BindGroups
                        // because the underlying Arena GPU buffer was destroyed and recreated.
                        mobjects.forEach(m => {
                            if (m.gpuSetupDone !== undefined) {
                                m.gpuSetupDone = false;
                            }
                        });
                    }

                    let triOffset = 0, nodeOffset = 0;

                    // 3. Serialize into the safe CPU Array views
                    meshList.forEach(mesh => {
                        mesh.triOffset = triOffset; mesh.bvhRootOffset = nodeOffset;
                        if (!mesh.localAABB) mesh.localAABB = mesh.bvh.nodes.length > 0 ? mesh.bvh.nodes[0].min.concat(mesh.bvh.nodes[0].max) : [0, 0, 0, 0, 0, 0];

                        this.serializeTris(mesh.bvh.triangles, this.triangleArena.f32, triOffset * 24);
                        this.serializeNodes(mesh.bvh.nodes, triOffset, nodeOffset, this.bvhArena.f32, this.bvhArena.i32, this.bvhArena.u32, nodeOffset);

                        // 4. Handle Morph/Compute Bindings Safely
                        if (mesh.isMorphing && !mesh.morphBuffersAllocated) {
                            mesh.bufTrisA = this.device.createBuffer({ size: mesh.activeTrisA.length * 96, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
                            mesh.bufTrisB = this.device.createBuffer({ size: mesh.activeTrisB.length * 96, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
                            mesh.bufLeafIndices = this.device.createBuffer({ size: mesh.leafIndices.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
                            mesh.bufFlags = this.device.createBuffer({ size: mesh.bvh.nodes.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
                            mesh.bufParams = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
                            mesh.bufParamsArray = new Uint32Array(4);
                            mesh.bufParamsF32 = new Float32Array(mesh.bufParamsArray.buffer);
                            mesh.morphBuffersAllocated = true;
                        }

                        // Notice how this checks !mesh.gpuSetupDone. Because we set it to false above 
                        // during a resize, this will safely execute and bind to the NEW Arena buffer.
                        if (mesh.isMorphing && !mesh.gpuSetupDone) {
                            let tmpA = new Float32Array(mesh.activeTrisA.length * 24); this.serializeTris(mesh.activeTrisA, tmpA, 0);
                            let tmpB = new Float32Array(mesh.activeTrisB.length * 24); this.serializeTris(mesh.activeTrisB, tmpB, 0);

                            this.device.queue.writeBuffer(mesh.bufTrisA, 0, tmpA);
                            this.device.queue.writeBuffer(mesh.bufTrisB, 0, tmpB);
                            this.device.queue.writeBuffer(mesh.bufLeafIndices, 0, new Uint32Array(mesh.leafIndices));

                            mesh.morphBindGroup = this.device.createBindGroup({
                                layout: this.refitPipeline.getBindGroupLayout(0),
                                entries: [
                                    { binding: 0, resource: { buffer: mesh.bufParams } },
                                    { binding: 1, resource: { buffer: mesh.bufTrisA } },
                                    { binding: 2, resource: { buffer: mesh.bufTrisB } },
                                    { binding: 3, resource: { buffer: mesh.bufLeafIndices } },
                                    { binding: 4, resource: { buffer: this.triangleArena.gpuBuffer } }, // Dynamically grabs the newest buffer
                                    { binding: 5, resource: { buffer: this.bvhArena.gpuBuffer } },      // Dynamically grabs the newest buffer
                                    { binding: 6, resource: { buffer: mesh.bufFlags } }
                                ]
                            });
                            mesh.gpuSetupDone = true;
                        }
                        triOffset += mesh.bvh.triangles.length; nodeOffset += mesh.bvh.nodes.length;
                    });

                    // 5. Zero-Copy Upload
                    this.triangleArena.upload(this.device.queue, triOffset);
                    this.bvhArena.upload(this.device.queue, nodeOffset);
                }
                update(mobjects, camera, frameCount, useDenoiser, rtEnabled, useDoF = true, tempSamples = 4, globalFrameOverride = null) {
                    const useLegacyMetal = document.getElementById('chkLegacyMetal') ? document.getElementById('chkLegacyMetal').checked : false;
                    const spheres = mobjects.filter(o => !o.triangles && o.radius !== undefined);
                    const meshes = mobjects.filter(o => o.triangles);

                    let rebind = false;
                    rebind |= this.sphereArena.ensureCapacity(spheres.length);
                    rebind |= this.meshArena.ensureCapacity(meshes.length);
                    if (rebind && this.bgLayout0) this.updateBindGroups();

                    if (frameCount === 0) {
                        this.camData.set(camera.pos, 36); this.camData.set(camera.dir, 40); this.camData.set(camera.up, 44); this.camData.set(camera.right, 48);
                    } else {
                        this.camData.set(this.camData.subarray(0, 4), 36); this.camData.set(this.camData.subarray(4, 8), 40);
                        this.camData.set(this.camData.subarray(8, 12), 44); this.camData.set(this.camData.subarray(12, 16), 48);
                    }

                    this.camData.set(camera.pos, 0); this.camData.set(camera.dir, 4); this.camData.set(camera.up, 8); this.camData.set(camera.right, 12);
                    this.camData.set([this.width, this.height, camera.fov, frameCount], 16);
                    this.camData.set([spheres.length, meshes.length, tempSamples, rtEnabled ? 1.0 : 0.0], 20);
                    this.camData.set([useDoF ? camera.aperture : 0.0, camera.focusDist, camera.bounces, camera.model || 0], 24);
                    this.camData.set([camera.skyColor[0], camera.skyColor[1], camera.skyColor[2], camera.skyIntensity], 28);
                    this.camData.set([camera.giMultiplier, camera.orthoScale, camera.lensShiftX, camera.lensShiftY], 32);

                    let globalFrame = globalFrameOverride !== null ? globalFrameOverride : frameCount;
                    this.camData.set([globalFrame, 0, 0, 0], 52); // Store the global seed

                    this.device.queue.writeBuffer(this.cameraBuffer, 0, this.camData);

                    if (spheres.length > 0) {
                        let sData = this.sphereArena.f32;
                        spheres.forEach((obj, i) => {
                            let wMat = obj.get_world_matrix(); if (!obj.prevPos) obj.prevPos = [wMat[12], wMat[13], wMat[14]];
                            let offset = i * 20;
                            sData.set([wMat[12], wMat[13], wMat[14], obj.radius * obj.scale[0]], offset);
                            sData.set([obj.prevPos[0], obj.prevPos[1], obj.prevPos[2], 0], offset + 4);
                            sData.set([obj.color[0], obj.color[1], obj.color[2], obj.smoothness], offset + 8);
                            sData.set([obj.emColor[0], obj.emColor[1], obj.emColor[2], obj.emStrength], offset + 12);
                            let finalMetallic = useLegacyMetal ? Math.max(0.0, (obj.smoothness - 0.5) * 2.0) : obj.metallic;
                            sData.set([obj.transparency, obj.ior, finalMetallic, obj.opacity], offset + 16);
                            obj.prevPos = [wMat[12], wMat[13], wMat[14]];
                        });
                        this.sphereArena.upload(this.device.queue, spheres.length);
                    }

                    if (meshes.length > 0) {
                        let mData = this.meshArena.f32;
                        meshes.forEach((obj, i) => {
                            let wMat = obj.get_world_matrix();
                            if (!obj.invMat) obj.invMat = Math3D.mat4(); if (!obj.prevMat) obj.prevMat = new Float32Array(wMat);
                            Math3D.mat4Invert(obj.invMat, wMat);

                            let offset = i * 72;
                            mData.set(obj.invMat, offset); mData.set(wMat, offset + 16); mData.set(obj.prevMat, offset + 32);

                            let aabb = obj.localAABB || [0, 0, 0, 0, 0, 0];
                            let worldAABB = computeWorldAABB([aabb[0], aabb[1], aabb[2]], [aabb[3], aabb[4], aabb[5]], wMat);

                            mData.set([worldAABB.min[0] - 0.01, worldAABB.min[1] - 0.01, worldAABB.min[2] - 0.01, obj.opacity], offset + 48);
                            mData.set([worldAABB.max[0] + 0.01, worldAABB.max[1] + 0.01, worldAABB.max[2] + 0.01, 0], offset + 52);
                            mData.set([obj.color[0], obj.color[1], obj.color[2], obj.smoothness], offset + 56);
                            mData.set([obj.emColor[0], obj.emColor[1], obj.emColor[2], obj.emStrength], offset + 60);

                            let finalMeshMetallic = useLegacyMetal ? Math.max(0.0, (obj.smoothness - 0.5) * 2.0) : obj.metallic;
                            let vecType = 0.0; if (obj.isVector) vecType = 1.0; else if (obj.isMSDF) vecType = 2.0; else if (obj.isImplicit) vecType = 3.0;
                            let packedZ = vecType + (obj.isSmooth ? 10.0 : 0.0);
                            mData.set([obj.transparency, obj.ior, packedZ, finalMeshMetallic], offset + 64);
                            mData.set([obj.bvhRootOffset, obj.triangles.length, obj.albedoTexIdx ?? -1.0, obj.normalTexIdx ?? -1.0], offset + 68);
                            obj.prevMat = new Float32Array(wMat);
                        });
                        this.meshArena.upload(this.device.queue, meshes.length);
                    }
                }
                async extractOIDN(frameCount) {
        let readTex = frameCount % 2 === 0 ? this.texA : this.texB;
        
        // Dynamically build the Bind Group with all 6 resources
        const extractBg = this.device.createBindGroup({
            layout: this.oidnExtractPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: readTex.createView() },
                { binding: 1, resource: { buffer: this.oidnColorBuf } },
                { binding: 2, resource: this.gBufferAlbedo.createView() },
                { binding: 3, resource: { buffer: this.oidnAlbedoBuf } },
                { binding: 4, resource: this.gBufferNormal.createView() },
                { binding: 5, resource: { buffer: this.oidnNormalBuf } }
            ]
        });

        const enc = this.device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(this.oidnExtractPipeline);
        pass.setBindGroup(0, extractBg);
        pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
        pass.end();

        this.device.queue.submit([enc.finish()]);
        await this.device.queue.onSubmittedWorkDone();

        // Return all 3 buffers so OIDNManager can route them
        return {
            color: this.oidnColorBuf,
            albedo: this.oidnAlbedoBuf,
            normal: this.oidnNormalBuf
        };
    }

                injectOIDN(denoisedGPUBuffer) {
                    const injectBg = this.device.createBindGroup({ layout: this.oidnInjectPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: denoisedGPUBuffer } }, { binding: 1, resource: this.oidnTexture.createView() }] });
                    const enc = this.device.createCommandEncoder();
                    const pass = enc.beginComputePass();
                    pass.setPipeline(this.oidnInjectPipeline); pass.setBindGroup(0, injectBg);
                    pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
                    pass.end();
                    this.device.queue.submit([enc.finish()]);
                }

                render(frameCount, isOffline = false, mobjects = [], skipMorph = false, skipScreen = false) {
                    const commandEncoder = this.device.createCommandEncoder();

                    let hasMorph = mobjects.some(m => m.isMorphing && m.gpuSetupDone);
                    if (hasMorph && !skipMorph) {
                        for (let m of mobjects) if (m.isMorphing && m.gpuSetupDone) commandEncoder.clearBuffer(m.bufFlags);
                        const computePass = commandEncoder.beginComputePass();
                        computePass.setPipeline(this.refitPipeline);
                        for (let m of mobjects) {
                            if (m.isMorphing && m.gpuSetupDone) {
                                m.bufParamsF32[0] = m.morphWeight; m.bufParamsArray[1] = m.triOffset; m.bufParamsArray[2] = m.bvhRootOffset; m.bufParamsArray[3] = m.leafIndices.length;
                                this.device.queue.writeBuffer(m.bufParams, 0, m.bufParamsArray);
                                computePass.setBindGroup(0, m.morphBindGroup); computePass.dispatchWorkgroups(Math.ceil(m.bufParamsArray[3] / 64));
                            }
                        }
                        computePass.end();
                    }

                    let readBG = frameCount % 2 === 0 ? this.bg1B : this.bg1A;
                    let writeTex = frameCount % 2 === 0 ? this.texA : this.texB;
                    let finalBG = frameCount % 2 === 0 ? this.screenBgA : this.screenBgB;

                    const gBufferPass = commandEncoder.beginRenderPass({
                        colorAttachments: [
                            { view: this.gBufferPos.createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' },
                            { view: this.gBufferNormal.createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' },
                            { view: this.gBufferAlbedo.createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' },
                            { view: this.gBufferMotion.createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }
                        ]
                    });
                    gBufferPass.setPipeline(this.gBufferPipeline);
                    gBufferPass.setBindGroup(0, this.bg0);
                    if (this.useScissor && this.tileRect) gBufferPass.setScissorRect(this.tileRect.x, this.tileRect.y, this.tileRect.width, this.tileRect.height);
                    gBufferPass.draw(3, 1, 0, 0);
                    gBufferPass.end();

                    const rtPass = commandEncoder.beginRenderPass({ colorAttachments: [{ view: writeTex.createView(), loadOp: 'load', storeOp: 'store' }] });
                    const rtPipelineToUse = this.rtTechnique === 0 ? this.rtPipelineClassic : this.rtPipelineReSTIR;
                    rtPass.setPipeline(rtPipelineToUse);
                    rtPass.setBindGroup(0, this.bg0);
                    rtPass.setBindGroup(1, readBG);
                    if (this.useScissor && this.tileRect) rtPass.setScissorRect(this.tileRect.x, this.tileRect.y, this.tileRect.width, this.tileRect.height);
                    rtPass.draw(3, 1, 0, 0);
                    rtPass.end();

                    if (!skipScreen) {
                        const targetView = isOffline ? this.readTexture.createView() : this.context.getCurrentTexture().createView();
                        const targetPipeline = isOffline ? this.offlineScreenPipeline : this.screenPipeline;
                        const screenPass = commandEncoder.beginRenderPass({ colorAttachments: [{ view: targetView, loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store' }] });
                        screenPass.setPipeline(targetPipeline); screenPass.setBindGroup(0, finalBG);
                        if (this.useScissor && this.tileRect) screenPass.setScissorRect(this.tileRect.x, this.tileRect.y, this.tileRect.width, this.tileRect.height);
                        screenPass.draw(3, 1, 0, 0); screenPass.end();
                        if (isOffline) commandEncoder.copyTextureToBuffer({ texture: this.readTexture }, { buffer: this.readBuffer, bytesPerRow: this.bytesPerRow }, [this.width, this.height, 1]);
                    }

                    this.device.queue.submit([commandEncoder.finish()]);
                }
            }


            // ==========================================
            // Manim-Like Animation System
            // ==========================================
            const rate_functions = {
                linear: t => t, smooth: t => t * t * (3 - 2 * t), easeIn: t => t * t, easeOut: t => t * (2 - t),
                easeOutBounce: t => {
                    const n1 = 7.5625, d1 = 2.75;
                    if (t < 1 / d1) return n1 * t * t;
                    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
                    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
                    return n1 * (t -= 2.625 / d1) * t + 0.984375;
                },
                easeOutElastic: t => t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1
            };
