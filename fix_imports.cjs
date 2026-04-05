const fs = require('fs');

const mobjectsImports = `import { Math3D } from '../math/math3d';
import { Material } from './mobjects'; // or self
import { Mobject } from './mobjects'; 
import { MeshObject } from './mobjects';
import { Group } from './mobjects';
import { VectorObject } from './mobjects';
import { SVGObject } from './mobjects';
// @ts-nocheck
`;

const scenesImports = `import { Math3D } from '../math/math3d';
import { RenderEngine } from '../engine/renderEngine';
import { OIDNManager } from '../gpu/oidnManager';
import { CameraController } from '../engine/camera';
import { Mobject, Group, MeshObject, Box, LightBox } from './mobjects';
import { Animation, Create, FadeIn, MoveCamera, Indicate, FadeOut } from './animations';
// @ts-nocheck
`;

function prepend(filename, text) {
    let content = fs.readFileSync(filename, 'utf-8');
    content = text + '\n' + content.replace('// @ts-nocheck', '');
    fs.writeFileSync(filename, content);
}

prepend('src/scene/mobjects.ts', mobjectsImports);
prepend('src/scene/scenes.ts', scenesImports);
