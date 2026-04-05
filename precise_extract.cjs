const fs = require('fs');

const lines = fs.readFileSync('src/original_engine.html', 'utf-8').split('\n');

function writeSlice(filename, importsStr, startLine, endLine) {
    // 1-indexed to 0-indexed slicing
    const content = lines.slice(startLine - 1, endLine).map(l => l.replace(/^            /, '')).join('\n');
    let exportedContent = content.replace(/^class /gm, 'export class ');
    // Make sure 'function ' at top level also gets exported if any? 
    // Wait, original file might not have top level functions there that need export.
    fs.writeFileSync(filename, importsStr + '\n\n' + exportedContent);
}

writeSlice('src/engine/camera.ts', '// @ts-nocheck\nimport { Math3D } from "../math/math3d";\n', 2762, 2949);

writeSlice('src/scene/animations.ts', '// @ts-nocheck\nimport { rate_functions } from "../math/rate_functions";\nimport { Mobject, Material, MeshObject, Group } from "./mobjects";\n', 3626, 3806);

writeSlice('src/scene/mobjects.ts', '// @ts-nocheck\nimport { Math3D, computeWorldAABB } from "../math/math3d";\nimport { _AnimateWrapper } from "./animations";\nimport { buildMeshBVH } from "../geometry/bvhBuilder";\n', 3807, 4862);

writeSlice('src/scene/scenes.ts', '// @ts-nocheck\nimport { Math3D } from "../math/math3d";\nimport { RenderEngine } from "../engine/renderEngine";\nimport { CameraController } from "../engine/camera";\nimport { Mobject, Material, MeshObject, Group, Box, LightBox, Sphere } from "./mobjects";\nimport { Animation, Create, FadeIn, FadeOut, MoveCamera, Indicate } from "./animations";\nimport { rate_functions } from "../math/rate_functions";\nimport { OIDNManager } from "../gpu/oidnManager";\n', 4863, 5736);

console.log('Precise extraction completed.');
