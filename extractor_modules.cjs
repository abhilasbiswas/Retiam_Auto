const fs = require('fs');
const content = fs.readFileSync('src/original_engine.html', 'utf-8');

function extractAndSave(startStr, endStr, outputFilename, exportPrefix = 'export ') {
    let startIdx = content.indexOf(startStr);
    if (startIdx === -1) return console.error("Not found: " + startStr);
    
    // Find matching bracket or end condition. In this case we just use indexOf for the endStr after startIdx
    let endIdx = content.indexOf(endStr, startIdx);
    if (endIdx === -1) return console.error("Not found end: " + endStr);
    
    let block = content.substring(startIdx, endIdx + endStr.length);
    // Replace "function " with "export function "
    block = block.replace(/function /g, 'export function ');
    // Replace "const " with "export const " for the top level only if needed
    
    // For classes, "class " to "export class "
    block = block.replace(/^(\s*)class /gm, '$1export class ');

    fs.writeFileSync(outputFilename, block);
    console.log(`Extracted to ${outputFilename}`);
}

extractAndSave("function buildMeshBVH", "return { nodes: bvhNodes, triangles: orderedTriangles, order: triIndices };\n            }", "src/geometry/bvhBuilder.ts");
extractAndSave("function parseMTL", "return group;\n                }\n                return new MeshObject(objData, isSmooth);\n            }", "src/geometry/objParser.ts");
extractAndSave("function generateProceduralSphere", "return tris;\n            }", "src/geometry/procedural.ts");
extractAndSave("function createSDFTexture", "return texture;\n            }", "src/geometry/sdfTexture.ts");
extractAndSave("class OIDNManager", "});\n    }\n}", "src/gpu/oidnManager.ts");
extractAndSave("class GPUArena", "});\n                }\n            }", "src/gpu/arena.ts");

// Utilities for ui graph
extractAndSave("function populateSceneGraph", "return { x: cx + x * radius, y: cy + y * radius, z };\n                };\n                const axes", "src/ui/sceneGraph.ts"); // Will manually fix this one
