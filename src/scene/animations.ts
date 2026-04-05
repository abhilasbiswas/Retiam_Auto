// @ts-nocheck
import { rate_functions } from "../math/rate_functions";
import { Math3D } from "../math/math3d";
import { Mobject, Material, MeshObject, Group } from "./mobjects";


export class Animation {
    constructor(mobject, kwargs = {}) {
        this.mobject = mobject;
        this.run_time = kwargs.run_time !== undefined ? kwargs.run_time : 1.0;
        this.rate_func = kwargs.rate_func || rate_functions.smooth;
        this.t = 0; this.finished = false; this.introducer = false;
    }
    begin() { } update(alpha) { } finish() { this.update(1.0); }
}

export class Create extends Animation {
    constructor(mobject, kwargs) { super(mobject, kwargs); this.introducer = true; }
    begin() { this.targetScale = [...this.mobject.scale]; this.mobject.scale = [0.0001, 0.0001, 0.0001]; }
    update(alpha) {
        this.mobject.scale = [
            this.targetScale[0] * alpha + 0.0001 * (1 - alpha), this.targetScale[1] * alpha + 0.0001 * (1 - alpha), this.targetScale[2] * alpha + 0.0001 * (1 - alpha)
        ];
    }
}

export class Write extends Animation {
    constructor(mobject, kwargs) { super(mobject, kwargs); this.introducer = true; }
    begin() { if (this.mobject.setReveal) this.mobject.setReveal(0); this.mobject.scale = [...this.mobject.scale]; }
    update(alpha) { if (this.mobject.setReveal) this.mobject.setReveal(alpha); }
}

export class Uncreate extends Animation {
    begin() { this.startScale = [...this.mobject.scale]; }
    update(alpha) {
        let inv = 1.0 - alpha;
        this.mobject.scale = [this.startScale[0] * inv + 0.0001 * alpha, this.startScale[1] * inv + 0.0001 * alpha, this.startScale[2] * inv + 0.0001 * alpha];
    }
    finish() { super.finish(); if (this.scene) this.scene.remove(this.mobject); }
}

export class FadeIn extends Animation { 
    constructor(mobject, kwargs) { super(mobject, kwargs); this.introducer = true; }
    begin() { this.mobject.opacity = 0.0; }
    update(alpha) { this.mobject.opacity = alpha; }
}

export class FadeOut extends Animation { 
    begin() { this.startOpacity = this.mobject.opacity; }
    update(alpha) { this.mobject.opacity = this.startOpacity * (1.0 - alpha); }
    finish() { super.finish(); if(this.scene) this.scene.remove(this.mobject); }
}

export class MorphAnim extends Animation { update(alpha) { if (this.mobject.setMorph) this.mobject.setMorph(alpha); } }

export class MethodAnimation extends Animation {
    constructor(mobject, targetState, kwargs) { super(mobject, kwargs); this.targetState = targetState; }
    begin() { this.startState = this.mobject.copyState(); }
    // Inside class MethodAnimation
    update(alpha) {
        const lerp = (a, b, t) => a + (b - a) * t;
        const lerpArr = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));

        this.mobject.position = lerpArr(this.startState.position, this.targetState.position, alpha);
        this.mobject.scale = lerpArr(this.startState.scale, this.targetState.scale, alpha);
        this.mobject.color = lerpArr(this.startState.color, this.targetState.color, alpha);

        // --- NEW QUATERNION ROTATION ---
        let qStart = Math3D.quatFromEuler(this.startState.rotation);
        let qEnd = Math3D.quatFromEuler(this.targetState.rotation);
        let qCurrent = Math3D.quatSlerp(qStart, qEnd, alpha);
        this.mobject.rotation = Math3D.eulerFromQuat(qCurrent);
        // -------------------------------

        this.mobject.emColor = lerpArr(this.startState.emColor, this.targetState.emColor, alpha);
        this.mobject.smoothness = lerp(this.startState.smoothness, this.targetState.smoothness, alpha);
        this.mobject.transparency = lerp(this.startState.transparency, this.targetState.transparency, alpha);
        this.mobject.ior = lerp(this.startState.ior, this.targetState.ior, alpha);
        this.mobject.emStrength = lerp(this.startState.emStrength, this.targetState.emStrength, alpha);
        this.mobject.value = lerp(this.startState.value, this.targetState.value, alpha);
    }
}

export class ReplacementTransform extends Animation {
    constructor(mobject, targetMobject, kwargs) { super(mobject, kwargs); this.targetMobject = targetMobject; }
    begin() {
        this.startState = this.mobject.copyState(); this.targetState = this.targetMobject.copyState();
        this.targetMobject.scale = [0.0001, 0.0001, 0.0001];
    }
    update(alpha) {
        const lerp = (a, b, t) => a + (b - a) * t; const lerpArr = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
        this.mobject.position = lerpArr(this.startState.position, this.targetState.position, alpha);
        this.mobject.rotation = lerpArr(this.startState.rotation, this.targetState.rotation, alpha);
        this.mobject.scale = lerpArr(this.startState.scale, this.targetState.scale, alpha);
        this.mobject.color = lerpArr(this.startState.color, this.targetState.color, alpha);
    }
    finish() {
        super.finish();
        if (this.scene) {
            this.scene.remove(this.mobject); this.targetMobject.applyState(this.targetState); this.scene.add(this.targetMobject);
        }
    }
}

export class Indicate extends Animation {
    begin() {
        this.startScale = [...this.mobject.scale];
        this.startEm = this.mobject.emStrength;
    }
    update(alpha) {
        let bump = Math.sin(alpha * Math.PI);
        this.mobject.scale = this.startScale.map(s => s * (1.0 + bump * 0.15));
        this.mobject.emStrength = this.startEm + (bump * 8.0);
    }
    finish() { this.mobject.scale = [...this.startScale]; this.mobject.emStrength = this.startEm; }
}

export class MoveCamera extends Animation {
    constructor(camera, targetProps, kwargs) {
        super(null, kwargs);
        this.camera = camera;
        this.targetProps = targetProps;
    }
    begin() {
        this.startProps = {
            pos: [...this.camera.pos], dir: [...this.camera.dir], focusDist: this.camera.focusDist, aperture: this.camera.aperture, fov: this.camera.fov
        };
    }
    update(alpha) {
        const lerp = (a, b, t) => a + (b - a) * t; const lerpArr = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
        if (this.targetProps.pos) this.camera.pos = lerpArr(this.startProps.pos, this.targetProps.pos, alpha);
        if (this.targetProps.dir) this.camera.dir = Math3D.normalize(lerpArr(this.startProps.dir, this.targetProps.dir, alpha));
        if (this.targetProps.focusDist !== undefined) this.camera.focusDist = lerp(this.startProps.focusDist, this.targetProps.focusDist, alpha);
        if (this.targetProps.aperture !== undefined) this.camera.aperture = lerp(this.startProps.aperture, this.targetProps.aperture, alpha);
        if (this.targetProps.fov !== undefined) this.camera.fov = lerp(this.startProps.fov, this.targetProps.fov, alpha);

        const upDir = Math3D.vec3(0, 1, 0);
        this.camera.right = Math3D.normalize(Math3D.cross(this.camera.dir, upDir));
        this.camera.up = Math3D.cross(this.camera.right, this.camera.dir);
    }
}

export class TransformMatchingShapes extends Animation {
    constructor(groupA, groupB, kwargs) {
        super(null, kwargs);
        this.arrA = groupA.children ? groupA.children : groupA;
        this.arrB = groupB.children ? groupB.children : groupB;
        this.transforms = [];
    }
    begin() {
        const count = Math.max(this.arrA.length, this.arrB.length);
        for (let i = 0; i < count; i++) {
            let a = this.arrA[i % this.arrA.length]; let b = this.arrB[i % this.arrB.length];
            let t = new ReplacementTransform(a, b, { run_time: this.run_time });
            t.scene = this.scene; t.begin();
            this.transforms.push(t);
        }
    }
    update(alpha) { this.transforms.forEach(t => t.update(alpha)); }
    finish() { this.transforms.forEach(t => t.finish()); }
}

export class _AnimateWrapper {
    constructor(mobject, kwargs = {}) {
        this.mobject = mobject; this.kwargs = kwargs; this.targetState = mobject.copyState();
    }
    shift(dx, dy, dz) { this.targetState.position[0] += dx; this.targetState.position[1] += dy; this.targetState.position[2] += dz; return this; }
    move_to(x, y, z) { this.targetState.position = [x, y, z]; return this; }
    scale_by(s) { this.targetState.scale[0] *= s; this.targetState.scale[1] *= s; this.targetState.scale[2] *= s; return this; }
    rotate(x, y, z) { this.targetState.rotation[0] += x; this.targetState.rotation[1] += y; this.targetState.rotation[2] += z; return this; }
    set_color(color) { this.targetState.color = color; return this; }
    set_material(color, smoothness, trans = 0.0, ior = 1.5, emColor = [0, 0, 0], emStrength = 0) {
        this.targetState.color = color; this.targetState.smoothness = smoothness; this.targetState.transparency = trans; this.targetState.ior = ior;
        this.targetState.emColor = emColor; this.targetState.emStrength = emStrength; return this;
    }
    set_value(v) { this.targetState.value = v; return this; }
    build() { return new MethodAnimation(this.mobject, this.targetState, this.kwargs); }
}

var N = 1;



// ==========================================
// Scene API & Architecture
// ==========================================
