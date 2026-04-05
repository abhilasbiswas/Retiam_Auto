// @ts-nocheck

export function parseMTL(str) {
                const materials = {};
                let currentMat = null;
                str.split('\n').forEach(line => {
                    line = line.split('#')[0].trim();
                    if (!line) return;
                    const p = line.split(/\s+/);

                    if (line.startsWith('newmtl ')) {
                        currentMat = line.substring(7).trim();
                        materials[currentMat] = { color: [1, 1, 1], smoothness: 0.0, emColor: [0, 0, 0], emStrength: 0.0, trans: 0.0, ior: 1.5 };
                    } else if (currentMat) {
                        if (p[0] === 'Kd') materials[currentMat].color = [parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])];
                        if (p[0] === 'Ke') {
                            let r = parseFloat(p[1]), g = parseFloat(p[2]), b = parseFloat(p[3]);
                            let maxVal = Math.max(r, g, b);
                            if (maxVal > 0) { materials[currentMat].emColor = [r / maxVal, g / maxVal, b / maxVal]; materials[currentMat].emStrength = maxVal; }
                            else { materials[currentMat].emColor = [0, 0, 0]; materials[currentMat].emStrength = 0.0; }
                        }
                        if (p[0] === 'Ns') { let ns = parseFloat(p[1]); if (ns > 0) materials[currentMat].smoothness = Math.min(1.0, Math.pow(ns / 1000.0, 0.33)); }
                        if (p[0] === 'Pr') materials[currentMat].smoothness = 1.0 - parseFloat(p[1]);
                        if (p[0] === 'd' || p[0] === 'Tr') materials[currentMat].trans = p[0] === 'd' ? 1.0 - parseFloat(p[1]) : parseFloat(p[1]);
                        if (p[0] === 'Ni') materials[currentMat].ior = parseFloat(p[1]);

                        if (p[0] === 'map_Kd') materials[currentMat].map_Kd = p[p.length - 1];
                        if (p[0] === 'map_Bump' || p[0] === 'bump') materials[currentMat].map_Bump = p[p.length - 1];
                    }
                });
                return materials;
            }

            async export function loadOBJFromURL(url, isSmooth = true, mtl = true) {
                try {
                    const response = await fetch(url);
                    if (!response.ok) throw new Error(`Failed to load OBJ`);
                    const objString = await response.text();
                    const objData = parseOBJ(objString);

                    let mtlUrl = null;
                    if (typeof mtl === 'string') mtlUrl = new URL(mtl, url).href;
                    else if (mtl === true) {
                        if (objData.mtllib) mtlUrl = new URL(objData.mtllib, url).href;
                        else mtlUrl = url.replace(/\.obj$/i, '.mtl');
                    }

                    if (mtlUrl) {
                        try {
                            const mtlResponse = await fetch(mtlUrl);
                            if (mtlResponse.ok) {
                                const mtlString = await mtlResponse.text();
                                const materials = parseMTL(mtlString);

                                const group = new Group();
                                for (let matName in objData.groups) {
                                    if (objData.groups[matName].length === 0) continue;
                                    let mesh = new MeshObject(objData.groups[matName], isSmooth);
                                    if (materials[matName]) {
                                        let m = materials[matName];
                                        mesh.set_material(m.color, m.smoothness, m.trans, m.ior, m.emColor, m.emStrength);
                                        if (m.map_Kd) mesh.albedoUrl = new URL(m.map_Kd, mtlUrl).href;
                                        if (m.map_Bump) mesh.normalUrl = new URL(m.map_Bump, mtlUrl).href;
                                    }
                                    group.add(mesh);
                                }
                                return group;
                            }
                        } catch (e) { console.warn("Failed to load MTL, falling back to default.", e); }
                    }
                    return new MeshObject(objData, isSmooth);
                } catch (error) { console.warn("Error fetching OBJ model.", error); return null; }
            }

            export function parseOBJ(str) {
                const verts = [], normals = [], uvs = [];
                const faces = [];
                const faceMaterials = [];

                let hasNormals = false, hasUVs = false;
                let currentMaterial = 'default';
                let mtllib = null;

                str.split('\n').forEach(line => {
                    line = line.split('#')[0].trim();
                    if (!line) return;

                    const p = line.split(/\s+/);
                    if (line.startsWith('mtllib ')) mtllib = line.substring(7).trim();
                    else if (line.startsWith('usemtl ')) currentMaterial = line.substring(7).trim();
                    else if (p[0] === 'v') verts.push([parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])]);
                    else if (p[0] === 'vn') { normals.push([parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])]); hasNormals = true; }
                    else if (p[0] === 'vt') { uvs.push([parseFloat(p[1]), parseFloat(p[2])]); hasUVs = true; }
                    else if (p[0] === 'f') {
                        for (let i = 2; i < p.length - 1; i++) {
                            faces.push([p[1], p[i], p[i + 1]]);
                            faceMaterials.push(currentMaterial);
                        }
                    }
                });

                let vertexNormals = [];
                if (!hasNormals) vertexNormals = Array(verts.length).fill(0).map(() => [0, 0, 0]);

                const parsedTris = [];
                faces.forEach((f, idx) => {
                    let v_idx = [], n_idx = [], t_idx = [];
                    for (let i = 0; i < 3; i++) {
                        let parts = f[i].split('/');
                        let vi = parseInt(parts[0]); vi = (vi < 0) ? (verts.length + vi) : (vi - 1); v_idx.push(vi);

                        if (hasUVs && parts[1]) { let ti = parseInt(parts[1]); ti = (ti < 0) ? (uvs.length + ti) : (ti - 1); t_idx.push(ti); }
                        else { t_idx.push(-1); }

                        if (hasNormals && parts[2]) { let ni = parseInt(parts[2]); ni = (ni < 0) ? (normals.length + ni) : (ni - 1); n_idx.push(ni); }
                        else { n_idx.push(vi); }
                    }

                    if (!hasNormals) {
                        let v0 = verts[v_idx[0]], v1 = verts[v_idx[1]], v2 = verts[v_idx[2]];
                        if (v0 && v1 && v2) {
                            let dx1 = v1[0] - v0[0], dy1 = v1[1] - v0[1], dz1 = v1[2] - v0[2]; let dx2 = v2[0] - v0[0], dy2 = v2[1] - v0[1], dz2 = v2[2] - v0[2];
                            let nx = dy1 * dz2 - dz1 * dy2, ny = dz1 * dx2 - dx1 * dz2, nz = dx1 * dy2 - dy1 * dx2;
                            for (let i = 0; i < 3; i++) { if (vertexNormals[v_idx[i]]) { vertexNormals[v_idx[i]][0] += nx; vertexNormals[v_idx[i]][1] += ny; vertexNormals[v_idx[i]][2] += nz; } }
                        }
                    }
                    parsedTris.push({ v: v_idx, n: n_idx, t: t_idx, mat: faceMaterials[idx] });
                });

                if (!hasNormals) {
                    for (let i = 0; i < vertexNormals.length; i++) {
                        let len = Math.hypot(vertexNormals[i][0], vertexNormals[i][1], vertexNormals[i][2]);
                        if (len > 0) { vertexNormals[i][0] /= len; vertexNormals[i][1] /= len; vertexNormals[i][2] /= len; } else { vertexNormals[i] = [0, 1, 0]; }
                    }
                }

                const finalTriangles = [];
                finalTriangles.groups = {};
                finalTriangles.mtllib = mtllib;

                parsedTris.forEach(t => {
                    let v0 = verts[t.v[0]], v1 = verts[t.v[1]], v2 = verts[t.v[2]];
                    if (!v0 || !v1 || !v2) return;
                    let n0, n1, n2;
                    if (hasNormals) { n0 = normals[t.n[0]] || [0, 1, 0]; n1 = normals[t.n[1]] || [0, 1, 0]; n2 = normals[t.n[2]] || [0, 1, 0]; }
                    else { n0 = vertexNormals[t.n[0]] || [0, 1, 0]; n1 = vertexNormals[t.n[1]] || [0, 1, 0]; n2 = vertexNormals[t.n[2]] || [0, 1, 0]; }

                    let uv0 = (t.t[0] !== -1) ? uvs[t.t[0]] : [0, 0];
                    let uv1 = (t.t[1] !== -1) ? uvs[t.t[1]] : [0, 0];
                    let uv2 = (t.t[2] !== -1) ? uvs[t.t[2]] : [0, 0];

                    let tri = [v0, v1, v2, n0, n1, n2, uv0, uv1, uv2];
                    finalTriangles.push(tri);

                    let m = t.mat || 'default';
                    if (!finalTriangles.groups[m]) finalTriangles.groups[m] = [];
                    finalTriangles.groups[m].push(tri);
                });

                return finalTriangles;
            }

            export function loadOBJFromString(objString, mtlString = null, isSmooth = true) {
                const objData = parseOBJ(objString);
                if (mtlString) {
                    const materials = parseMTL(mtlString);
                    const group = new Group();
                    for (let matName in objData.groups) {
                        if (objData.groups[matName].length === 0) continue;
                        let mesh = new MeshObject(objData.groups[matName], isSmooth);
                        if (materials[matName]) {
                            let m = materials[matName];
                            mesh.set_material(m.color, m.smoothness, m.trans, m.ior, m.emColor, m.emStrength);
                        }
                        group.add(mesh);
                    }
                    return group;
                }
                return new MeshObject(objData, isSmooth);
            }