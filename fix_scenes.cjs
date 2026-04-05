const fs = require('fs');
const lines = fs.readFileSync('src/original_engine.html', 'utf-8').split('\n');
const content = lines.slice(4862, 5865).map(l => l.replace(/^            /, '')).join('\n');
let exportedContent = content.replace(/^class /gm, 'export class ');
fs.writeFileSync('src/scene/scenes.ts', '// @ts-nocheck\nimport { Math3D } from "../math/math3d";\nimport { RenderEngine } from "../engine/renderEngine";\nimport { CameraController } from "../engine/camera";\nimport { Mobject, Material, MeshObject, Group, Box, LightBox, Sphere } from "./mobjects";\nimport { Animation, Create, FadeIn, FadeOut, MoveCamera, Indicate } from "./animations";\nimport { rate_functions } from "../math/rate_functions";\nimport { OIDNManager } from "../gpu/oidnManager";\n\n' + exportedContent);
console.log('Fixed scenes.ts');
