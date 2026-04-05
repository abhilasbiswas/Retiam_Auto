const fs = require('fs');
let content = fs.readFileSync('src/main_logic.ts', 'utf-8');

function removeBlock(startStr, endStr) {
    let startIdx = content.indexOf(startStr);
    if (startIdx === -1) return;
    let endIdx = content.indexOf(endStr, startIdx);
    if (endIdx === -1) return;
    let text = content.substring(startIdx, endIdx + endStr.length);
    content = content.replace(text, `/* Extracted Logic */`);
}

removeBlock("class OIDNManager", "}\n}");
removeBlock("class GPUArena", "}\n            }");
removeBlock("function populateSceneGraph", "};\n                const axes"); // Partial removal
removeBlock("const Math3D =", "}");
removeBlock("function computeWorldAABB", "}");
removeBlock("function buildMeshBVH", "return { nodes: bvhNodes, triangles: orderedTriangles, order: triIndices };\n            }");
removeBlock("function parseMTL", "return group;\n                }\n                return new MeshObject(objData, isSmooth);\n            }");
removeBlock("function generateProceduralSphere", "return tris;\n            }");
removeBlock("function createSDFTexture", "return texture;\n            }");

fs.writeFileSync('src/main.ts', content);
