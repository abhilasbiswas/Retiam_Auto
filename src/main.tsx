import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './ui/App';
import './ui/styles.css';

import * as ti from 'taichi.js';
// @ts-ignore
window.ti = ti;

document.addEventListener('DOMContentLoaded', () => {
    console.log("WebGPU Cinematic Editor (React) Booting...");

    if (!navigator.gpu) {
        alert("WebGPU not supported on this browser.");
        return;
    }

    createRoot(document.getElementById('root')!).render(
        <StrictMode>
            <App />
        </StrictMode>
    );
});