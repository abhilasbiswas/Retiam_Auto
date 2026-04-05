const fs = require('fs');
let lines = fs.readFileSync('src/original_engine.html', 'utf-8').split('\n');
let classText = lines.slice(2949, 3625).join('\n'); // 0-indexed
fs.writeFileSync('src/engine/renderEngine.ts', 
        "// @ts-nocheck\n" +
        "import { Math3D } from '../math/math3d';\n" +
        "import { OIDNManager } from '../gpu/oidnManager';\n" +
        "import { CameraController } from './camera';\n" + 
        "import { shaders } from '../shaders/index';\n" + 
        "import { GPUArena } from '../gpu/arena';\n\n" + 
        "export " + classText);
console.log('RenderEngine extracted exactly by lines.');
