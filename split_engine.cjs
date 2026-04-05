const fs = require('fs');

let content = fs.readFileSync('src/full_script.ts', 'utf-8');

// Function to pull out a class and all its methods by matching "class Name" 
function extractClass(className) {
    const regex = new RegExp(`class ${className} [\\s\\S]*?(?=\\n\\s*class |\\n\\s*const |\\n\\s*let |\\n\\s*function |$)`, 'g');
    let match = regex.exec(content);
    if (!match) {
        // try alternative ending
        const regex2 = new RegExp(`class ${className}[\\s\\S]*?(?=\\n[a-z])`, 'gi');
        match = regex2.exec(content);
    }
    if (match) {
        const text = match[0];
        content = content.replace(text, `/* Extracted ${className} */\n`);
        return 'export ' + text.trim();
    }
    console.error(`Class ${className} not found`);
    return '';
}

function extractAllTo(classesList, filename) {
    let out = '';
    classesList.forEach(c => { out += extractClass(c) + "\n\n"; });
    fs.writeFileSync(filename, out);
    console.log(`Saved ${filename}`);
}

extractAllTo([
    'Mobject', 'ValueTracker', 'Group', 'MeshObject', 'TaichiWater', 'NativeGPUWater',
    'ParametricSurface', 'RaytracedPath', 'VectorAtlas', 'VectorObject', 'TextObject',
    'SVGObject', 'MathTex', 'ImageObject', 'VideoObject', 'MSDFObject',
    'ImplicitCurveObject', 'Sphere', 'MorphMeshObject', 'Material'
], 'src/scene/mobjects.ts');

extractAllTo([
    'Animation', 'Create', 'Write', 'Uncreate', 'FadeIn', 'FadeOut', 'MorphAnim',
    'MethodAnimation', 'ReplacementTransform', 'Indicate', 'MoveCamera', 'TransformMatchingShapes'
], 'src/scene/animations.ts');

extractAllTo([
    'Scene', 'CornellBoxScene', 'NativeWaterScene', 'TaichiWaterScene', 'Box', 'LightBox', 'VoxelRoomScene'
], 'src/scene/scenes.ts');

// We also need to extract CameraController and RenderEngine
extractAllTo(['CameraController'], 'src/engine/camera.ts');
extractAllTo(['RenderEngine'], 'src/engine/renderEngine.ts');

// The remaining content (event listeners, raw logic) will go to main.ts
fs.writeFileSync('src/main_logic.ts', content);
