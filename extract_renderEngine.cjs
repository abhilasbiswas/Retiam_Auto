const fs = require('fs');
let content = fs.readFileSync('src/original_engine.html', 'utf-8');
const startIdx = content.indexOf('class RenderEngine');
if (startIdx === -1) { console.log('not found'); process.exit(1); }

let braceCount = 0;
let foundFirstBrace = false;
let endIdx = -1;

for (let i = startIdx; i < content.length; i++) {
    if (content[i] === '{') {
        braceCount++;
        foundFirstBrace = true;
    } else if (content[i] === '}') {
        braceCount--;
    }
    
    if (foundFirstBrace && braceCount === 0) {
        endIdx = i;
        break;
    }
}

if (endIdx !== -1) {
    let classText = content.substring(startIdx, endIdx + 1);
    fs.writeFileSync('src/engine/renderEngine.ts', 
        "// @ts-nocheck\n" +
        "import { Math3D } from '../math/math3d';\n" +
        "import { OIDNManager } from '../gpu/oidnManager';\n" +
        "import { CameraController } from './camera';\n" + 
        "import { shaders } from '../shaders/index';\n" + 
        "import { GPUArena } from '../gpu/arena';\n\n" + 
        "export " + classText);
    console.log('RenderEngine extracted fully.');
}
