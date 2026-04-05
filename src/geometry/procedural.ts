// @ts-nocheck

export function generateProceduralSphere(radius, radialSegments, tubularSegments) {
                const vertices = [], normals = [], tris = [];
                for (let i = 0; i <= radialSegments; i++) {
                    let u = (i / radialSegments) * Math.PI * 2;
                    for (let j = 0; j <= tubularSegments; j++) {
                        let v = (j / tubularSegments) * Math.PI;
                        let x = radius * Math.sin(v) * Math.cos(u); let y = radius * Math.sin(v) * Math.sin(u); let z = radius * Math.cos(v);
                        vertices.push([x, y, z]); normals.push(Math3D.normalize([x, y, z]));
                    }
                }
                for (let i = 0; i < radialSegments; i++) {
                    for (let j = 0; j < tubularSegments; j++) {
                        let p1 = i * (tubularSegments + 1) + j, p2 = p1 + 1; let p3 = (i + 1) * (tubularSegments + 1) + j, p4 = p3 + 1;
                        tris.push([vertices[p1], vertices[p2], vertices[p3], normals[p1], normals[p2], normals[p3]]);
                        tris.push([vertices[p2], vertices[p4], vertices[p3], normals[p2], normals[p4], normals[p3]]);
                    }
                }
                return tris;
            }