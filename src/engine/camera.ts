// @ts-nocheck
import { Math3D } from "../math/math3d";

export class CameraController {
    constructor(camera, canvas) {
        this.camera = camera; this.canvas = canvas; this.keys = {};
        this.pitch = Math.asin(camera.dir[1]); this.yaw = Math.atan2(camera.dir[0], camera.dir[2]);
        this.lastDir = new Float32Array([camera.dir[0], camera.dir[1], camera.dir[2]]);

        this.speed = 8.0; this.sensitivity = 0.003; this.locked = false;
        this.rtEnabled = false; this.useDoF = true;
        this.targetFocus = camera.focusDist; 
        this.autoFocus = true;

        this.isDragging = false;
        this.dragInfo = null;
        this.dragMoved = false;
        this.lastMobjects = [];
        this.recorder = null; // InteractionRecorder reference, set by Scene
        this.sceneClock = () => 0; // Function to get current scene clock

        window.addEventListener('keydown', e => this.keys[e.code] = true);
        window.addEventListener('keyup', e => this.keys[e.code] = false);

        canvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || window.isRenderingVideo) return;
            
            let rect = canvas.getBoundingClientRect();
            let rayDir = this.getRayFromMouse(e.clientX - rect.left, e.clientY - rect.top, rect);
            let hit = this.raycast(this.camera.pos, rayDir, this.lastMobjects || [], true);
            
            if (hit.object && hit.object.onMouseDown) {
                let intersectPt = [
                    this.camera.pos[0] + rayDir[0] * hit.distance,
                    this.camera.pos[1] + rayDir[1] * hit.distance,
                    this.camera.pos[2] + rayDir[2] * hit.distance
                ];
                
                // Record the event
                if (this.recorder && this.recorder.isRecording && hit.object.name) {
                    this.recorder.captureEvent('mousedown', this.sceneClock(), hit.object.name, intersectPt, Math3D.normalize([...rayDir]));
                }

                let consumed = hit.object.onMouseDown(intersectPt, Math3D.normalize([...rayDir]), Math3D.normalize([...this.camera.dir]));
                
                if (consumed !== false) {
                    this.dragInfo = {
                        object: hit.object,
                        planeNormal: [...this.camera.dir],
                        planePt: intersectPt
                    };
                    this.isDragging = true;
                    return;
                } else {
                    // Click-only event (consumed === false) — still record mouseup immediately
                    if (this.recorder && this.recorder.isRecording) {
                        this.recorder.captureEvent('mouseup', this.sceneClock());
                    }
                    this.dragMoved = true; // trigger accumulation clear for material changes
                }
            }
            
            canvas.requestPointerLock();
        });

        document.addEventListener('mouseup', (e) => {
            if (e.button === 0) {
                if (this.isDragging && this.dragInfo) {
                    if (this.recorder && this.recorder.isRecording) {
                        this.recorder.captureEvent('mouseup', this.sceneClock());
                    }
                    if (this.dragInfo.object.onMouseUp) {
                        this.dragInfo.object.onMouseUp();
                    }
                }
                this.isDragging = false;
                this.dragInfo = null;
            }
        });

        document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === canvas; });

        document.addEventListener('mousemove', e => {
            if (window.isRenderingVideo) return;
            
            if (this.isDragging && this.dragInfo) {
                let rect = canvas.getBoundingClientRect();
                let rayDir = this.getRayFromMouse(e.clientX - rect.left, e.clientY - rect.top, rect);
                
                let num = 
                    this.dragInfo.planeNormal[0] * (this.dragInfo.planePt[0] - this.camera.pos[0]) +
                    this.dragInfo.planeNormal[1] * (this.dragInfo.planePt[1] - this.camera.pos[1]) +
                    this.dragInfo.planeNormal[2] * (this.dragInfo.planePt[2] - this.camera.pos[2]);
                    
                let den = 
                    this.dragInfo.planeNormal[0] * rayDir[0] +
                    this.dragInfo.planeNormal[1] * rayDir[1] +
                    this.dragInfo.planeNormal[2] * rayDir[2];

                if (Math.abs(den) > 0.0001) {
                    let tHit = num / den;
                    let newIntersectPt = [
                        this.camera.pos[0] + rayDir[0] * tHit,
                        this.camera.pos[1] + rayDir[1] * tHit,
                        this.camera.pos[2] + rayDir[2] * tHit
                    ];
                    
                    if (this.dragInfo.object.onMouseDrag) {
                        // Record the drag event
                        if (this.recorder && this.recorder.isRecording && this.dragInfo.object.name) {
                            this.recorder.captureEvent('mousemove', this.sceneClock(), null, [...newIntersectPt], Math3D.normalize([...rayDir]));
                        }
                        let objMoved = this.dragInfo.object.onMouseDrag(newIntersectPt, Math3D.normalize([...rayDir]), tHit);
                        if (objMoved !== false) this.dragMoved = true;
                    }
                }
            } else if (this.locked) {
                this.yaw -= e.movementX * this.sensitivity; this.pitch -= e.movementY * this.sensitivity;
                const limit = Math.PI / 2 - 0.01; this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
            }
        });
    }

    getRayFromMouse(x, y, rect) {
        let ndcX = (x / rect.width) * 2 - 1;
        let ndcY = -(y / rect.height) * 2 + 1;
        let aspect = rect.width / rect.height;
        let tanFov = Math.tan(this.camera.fov * 0.5);
        
        let dx = this.camera.right[0] * ndcX * aspect * tanFov + this.camera.up[0] * ndcY * tanFov;
        let dy = this.camera.right[1] * ndcX * aspect * tanFov + this.camera.up[1] * ndcY * tanFov;
        let dz = this.camera.right[2] * ndcX * aspect * tanFov + this.camera.up[2] * ndcY * tanFov;
        
        return Math3D.normalize([
            this.camera.dir[0] + dx,
            this.camera.dir[1] + dy,
            this.camera.dir[2] + dz
        ]);
    }

    raycast(origin, dir, mobjects, onlyInteractable = false) {
        let closestInfo = { distance: 999999, object: null };

        for (let m of mobjects) {
            if (onlyInteractable && !m.isInteractable) continue;

            if (!m.triangles && m.radius !== undefined) {
                let oc = Math3D.sub(origin, m.position);
                let dotOCDir = oc[0] * dir[0] + oc[1] * dir[1] + oc[2] * dir[2];
                let c = (oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2]) - (m.radius * m.scale[0]) ** 2;
                let disc = dotOCDir * dotOCDir - c;
                if (disc > 0) {
                    let t = -dotOCDir - Math.sqrt(disc);
                    if (t > 0 && t < closestInfo.distance) {
                        closestInfo.distance = t;
                        closestInfo.object = m;
                    }
                }
            }
            else if (m.triangles && m.bvh && m.bvh.nodes.length) {
                let invMat = Math3D.mat4();
                Math3D.mat4Invert(invMat, m.get_world_matrix());

                let lO = [
                    invMat[0] * origin[0] + invMat[4] * origin[1] + invMat[8] * origin[2] + invMat[12],
                    invMat[1] * origin[0] + invMat[5] * origin[1] + invMat[9] * origin[2] + invMat[13],
                    invMat[2] * origin[0] + invMat[6] * origin[1] + invMat[10] * origin[2] + invMat[14]
                ];
                let lD = [
                    invMat[0] * dir[0] + invMat[4] * dir[1] + invMat[8] * dir[2],
                    invMat[1] * dir[0] + invMat[5] * dir[1] + invMat[9] * dir[2],
                    invMat[2] * dir[0] + invMat[6] * dir[1] + invMat[10] * dir[2]
                ];
                let invLD = [1 / lD[0], 1 / lD[1], 1 / lD[2]];

                let stack = [0];
                let hitDist = 999999;
                while (stack.length > 0) {
                    let nodeIdx = stack.pop();
                    let node = m.bvh.nodes[nodeIdx];

                    let t1 = (node.min[0] - lO[0]) * invLD[0], t2 = (node.max[0] - lO[0]) * invLD[0];
                    let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2);
                    let t3 = (node.min[1] - lO[1]) * invLD[1], t4 = (node.max[1] - lO[1]) * invLD[1];
                    tmin = Math.max(tmin, Math.min(t3, t4)); tmax = Math.min(tmax, Math.max(t3, t4));
                    let t5 = (node.min[2] - lO[2]) * invLD[2], t6 = (node.max[2] - lO[2]) * invLD[2];
                    tmin = Math.max(tmin, Math.min(t5, t6)); tmax = Math.min(tmax, Math.max(t5, t6));

                    if (tmax < Math.max(0, tmin) || tmin >= hitDist) continue;

                    if (node.triCount > 0) {
                        for (let i = 0; i < node.triCount; i++) {
                            let tri = m.bvh.triangles[node.leftFirst + i];
                            let e1 = [tri[1][0] - tri[0][0], tri[1][1] - tri[0][1], tri[1][2] - tri[0][2]];
                            let e2 = [tri[2][0] - tri[0][0], tri[2][1] - tri[0][1], tri[2][2] - tri[0][2]];
                            let h = Math3D.cross(lD, e2);
                            let a = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
                            if (a > -0.00001 && a < 0.00001) continue;

                            let f = 1.0 / a;
                            let s = [lO[0] - tri[0][0], lO[1] - tri[0][1], lO[2] - tri[0][2]];
                            let u = f * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
                            if (u < 0.0 || u > 1.0) continue;

                            let q = Math3D.cross(s, e1);
                            let v = f * (lD[0] * q[0] + lD[1] * q[1] + lD[2] * q[2]);
                            if (v < 0.0 || u + v > 1.0) continue;

                            let t = f * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]);
                            let worldDist = t * Math3D.length(lD);
                            if (worldDist > 0.001 && worldDist < hitDist) hitDist = worldDist;
                        }
                    } else {
                        stack.push(node.leftFirst, node.leftFirst + 1);
                    }
                }
                
                if (hitDist < closestInfo.distance) {
                    closestInfo.distance = hitDist;
                    closestInfo.object = m;
                }
            }
        }

        return closestInfo;
    }

    update(dt, mobjects = []) {
        if (window.isRenderingVideo) return false;
        this.lastMobjects = mobjects;
        let moved = false;

        if (this.dragMoved) {
            moved = true;
            this.dragMoved = false; // Reset flag
        }

        let dirChangedExternally =
            Math.abs(this.camera.dir[0] - this.lastDir[0]) > 0.0001 ||
            Math.abs(this.camera.dir[1] - this.lastDir[1]) > 0.0001 ||
            Math.abs(this.camera.dir[2] - this.lastDir[2]) > 0.0001;

        if (dirChangedExternally) {
            this.yaw = Math.atan2(this.camera.dir[0], this.camera.dir[2]);
            this.pitch = Math.asin(this.camera.dir[1]);
            moved = true;
        }

        let oldDirX = this.camera.dir[0], oldDirY = this.camera.dir[1], oldDirZ = this.camera.dir[2];

        this.camera.dir[0] = Math.cos(this.pitch) * Math.sin(this.yaw);
        this.camera.dir[1] = Math.sin(this.pitch);
        this.camera.dir[2] = Math.cos(this.pitch) * Math.cos(this.yaw);

        if (Math.abs(oldDirX - this.camera.dir[0]) > 0.001 || Math.abs(oldDirY - this.camera.dir[1]) > 0.001) moved = true;

        this.lastDir[0] = this.camera.dir[0];
        this.lastDir[1] = this.camera.dir[1];
        this.lastDir[2] = this.camera.dir[2];

        const upDir = Math3D.vec3(0, 1, 0);
        this.camera.right = Math3D.normalize(Math3D.cross(this.camera.dir, upDir));
        this.camera.up = Math3D.cross(this.camera.right, this.camera.dir);

        let velocity = Math3D.vec3(0, 0, 0);
        if (this.keys['KeyW']) velocity = Math3D.add(velocity, this.camera.dir);
        if (this.keys['KeyS']) velocity = Math3D.sub(velocity, this.camera.dir);
        if (this.keys['KeyA']) velocity = Math3D.sub(velocity, this.camera.right);
        if (this.keys['KeyD']) velocity = Math3D.add(velocity, this.camera.right);
        if (this.keys['Space']) velocity = Math3D.add(velocity, Math3D.vec3(0, 1, 0));
        if (this.keys['ShiftLeft']) velocity = Math3D.sub(velocity, Math3D.vec3(0, 1, 0));

        if (Math3D.length(velocity) > 0) {
            velocity = Math3D.scale(Math3D.normalize(velocity), this.speed * dt);
            this.camera.pos = Math3D.add(this.camera.pos, velocity); moved = true;
        }

        if (this.keys['KeyQ']) { this.camera.focusDist = Math.max(0.1, this.camera.focusDist - 10.0 * dt); moved = true; this.autoFocus = false; }
        if (this.keys['KeyE']) { this.camera.focusDist += 10.0 * dt; moved = true; this.autoFocus = false; }

        if (this.keys['KeyF'] && !this.fPressed) { this.autoFocus = !this.autoFocus; this.fPressed = true; } else if (!this.keys['KeyF']) { this.fPressed = false; }
        if (this.keys['BracketLeft']) { this.camera.aperture = Math.max(0.0, this.camera.aperture - 0.1 * dt); moved = true; }
        if (this.keys['BracketRight']) { this.camera.aperture += 0.1 * dt; moved = true; }
        if (this.keys['Minus']) { this.camera.fov = Math.max(0.1, this.camera.fov - 0.5 * dt); moved = true; }
        if (this.keys['Equal']) { this.camera.fov = Math.min(Math.PI - 0.1, this.camera.fov + 0.5 * dt); moved = true; }

        if (this.autoFocus && mobjects) {
            let hit = this.raycast(this.camera.pos, this.camera.dir, mobjects);
            let closest = hit.distance;

            if (closest !== 999999) {
                if (Math.abs(closest - this.targetFocus) > 0.5) this.targetFocus = closest;
            } else {
                if (Math.abs(10.0 - this.targetFocus) > 0.5) this.targetFocus = 10.0;
            }

            if (Math.abs(this.camera.focusDist - this.targetFocus) > 0.05) {
                this.camera.focusDist += (this.targetFocus - this.camera.focusDist) * 5.0 * dt;
                moved = true;
            } else {
                this.camera.focusDist = this.targetFocus;
            }
        }

        if (this.keys['KeyR'] && !this.rPressed) {
            let sel = document.getElementById('selPreviewDenoiser');
            if (sel) {
                sel.value = (parseInt(sel.value) + 1) % 4;
                sel.dispatchEvent(new Event('change'));
            }
            this.rPressed = true; moved = true;
        } else if (!this.keys['KeyR']) {
            this.rPressed = false;
        }

        if (this.keys['KeyT'] && !this.tPressed) { document.getElementById('btnToggleRT').click(); this.tPressed = true; moved = true; } else if (!this.keys['KeyT']) { this.tPressed = false; }
        if (this.keys['KeyB'] && !this.bPressed) { document.getElementById('btnToggleDoF').click(); this.bPressed = true; moved = true; } else if (!this.keys['KeyB']) { this.bPressed = false; }

        return moved;
    }

}