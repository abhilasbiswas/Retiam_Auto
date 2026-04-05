import './style.css';// The import logic will be expanded once modules export correctly.
import { VoxelRoomScene } from './scene/scenes';

import * as ti from 'taichi.js';
// @ts-ignore
window.ti = ti;

document.addEventListener('DOMContentLoaded', () => {
    console.log("WebGPU Cinematic Path Tracer Booting...");

    // Check WebGPU Support
    if (!navigator.gpu) {
        alert("WebGPU not supported on this browser.");
        return;
    }

    const scene = new VoxelRoomScene();
    scene.run();
});