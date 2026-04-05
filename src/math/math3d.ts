// Minimal Math Library adapted from previous engine
export const Math3D = {
    vec3: (x: number = 0, y: number = 0, z: number = 0): Float32Array => new Float32Array([x, y, z]),
    add: (a: Float32Array | number[], b: Float32Array | number[]): Float32Array => Math3D.vec3(a[0] + b[0], a[1] + b[1], a[2] + b[2]),
    sub: (a: Float32Array | number[], b: Float32Array | number[]): Float32Array => Math3D.vec3(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
    scale: (a: Float32Array | number[], s: number): Float32Array => Math3D.vec3(a[0] * s, a[1] * s, a[2] * s),
    cross: (a: Float32Array | number[], b: Float32Array | number[]): Float32Array => Math3D.vec3(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]),
    length: (a: Float32Array | number[]): number => Math.hypot(a[0], a[1], a[2]),
    normalize: (a: Float32Array | number[]): Float32Array => { 
        let len = Math3D.length(a); 
        return len > 0 ? Math3D.vec3(a[0] / len, a[1] / len, a[2] / len) : Math3D.vec3(0, 0, 0); 
    },
    mat4: (): Float32Array => new Float32Array(16),
    mat4Identity: (out: Float32Array): Float32Array => { 
        out.fill(0); 
        out[0] = out[5] = out[10] = out[15] = 1; 
        return out; 
    },
    mat4Multiply: (out: Float32Array, a: Float32Array | number[], b: Float32Array | number[]): Float32Array => {
        let a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7], a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
        let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
        out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30; out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31; out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32; out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
        b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
        out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30; out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31; out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32; out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
        b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
        out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30; out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31; out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32; out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
        b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
        out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30; out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31; out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32; out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
        return out;
    },
    mat4FromTransform: (out: Float32Array, pos: Float32Array | number[], rot: Float32Array | number[], scale: Float32Array | number[]): Float32Array => {
        Math3D.mat4Identity(out); out[12] = pos[0]; out[13] = pos[1]; out[14] = pos[2];
        let temp = Math3D.mat4(), s = Math.sin(rot[2]), c = Math.cos(rot[2]); Math3D.mat4Identity(temp);
        temp[0] = c; temp[1] = s; temp[4] = -s; temp[5] = c; Math3D.mat4Multiply(out, out, temp);
        s = Math.sin(rot[1]); c = Math.cos(rot[1]); Math3D.mat4Identity(temp);
        temp[0] = c; temp[2] = -s; temp[8] = s; temp[10] = c; Math3D.mat4Multiply(out, out, temp);
        s = Math.sin(rot[0]); c = Math.cos(rot[0]); Math3D.mat4Identity(temp);
        temp[5] = c; temp[6] = s; temp[9] = -s; temp[10] = c; Math3D.mat4Multiply(out, out, temp);
        out[0] *= scale[0]; out[1] *= scale[0]; out[2] *= scale[0];
        out[4] *= scale[1]; out[5] *= scale[1]; out[6] *= scale[1];
        out[8] *= scale[2]; out[9] *= scale[2]; out[10] *= scale[2];
        return out;
    },
    mat4Invert: (out: Float32Array, a: Float32Array | number[]): Float32Array | null => {
        let a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
            a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
        let b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11,
            b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30,
            b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
        let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
        if (!det) return null; det = 1.0 / det;
        out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det; out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
        out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det; out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
        out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det; out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
        out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det; out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
        return out;
    },
    quat: (x: number = 0, y: number = 0, z: number = 0, w: number = 1): Float32Array => new Float32Array([x, y, z, w]),
    quatFromEuler: (euler: Float32Array | number[]): Float32Array => {
        let cx = Math.cos(euler[0] / 2), sx = Math.sin(euler[0] / 2);
        let cy = Math.cos(euler[1] / 2), sy = Math.sin(euler[1] / 2);
        let cz = Math.cos(euler[2] / 2), sz = Math.sin(euler[2] / 2);
        return Math3D.quat(
            sx * cy * cz - cx * sy * sz,
            cx * sy * cz + sx * cy * sz,
            cx * cy * sz - sx * sy * cz,
            cx * cy * cz + sx * sy * sz
        );
    },
    quatSlerp: (a: Float32Array | number[], b: Float32Array | number[], t: number): Float32Array => {
        let out = Math3D.quat();
        let cosHalfTheta = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
        if (cosHalfTheta < 0) {
            b = [-b[0], -b[1], -b[2], -b[3]];
            cosHalfTheta = -cosHalfTheta;
        }
        if (Math.abs(cosHalfTheta) >= 1.0) return Math3D.quat(a[0], a[1], a[2], a[3]);
        let halfTheta = Math.acos(cosHalfTheta);
        let sinHalfTheta = Math.sqrt(1.0 - cosHalfTheta * cosHalfTheta);
        if (Math.abs(sinHalfTheta) < 0.001) {
            return Math3D.quat(a[0] * 0.5 + b[0] * 0.5, a[1] * 0.5 + b[1] * 0.5, a[2] * 0.5 + b[2] * 0.5, a[3] * 0.5 + b[3] * 0.5);
        }
        let ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
        let ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
        out[0] = (a[0] * ratioA) + (b[0] * ratioB);
        out[1] = (a[1] * ratioA) + (b[1] * ratioB);
        out[2] = (a[2] * ratioA) + (b[2] * ratioB);
        out[3] = (a[3] * ratioA) + (b[3] * ratioB);
        return out;
    },
    eulerFromQuat: (q: Float32Array | number[]): Float32Array => {
        let ysqr = q[1] * q[1];
        let t0 = +2.0 * (q[3] * q[0] + q[1] * q[2]);
        let t1 = +1.0 - 2.0 * (q[0] * q[0] + ysqr);
        let pitch = Math.atan2(t0, t1);
        let t2 = +2.0 * (q[3] * q[1] - q[2] * q[0]);
        t2 = t2 > 1.0 ? 1.0 : t2; t2 = t2 < -1.0 ? -1.0 : t2;
        let yaw = Math.asin(t2);
        let t3 = +2.0 * (q[3] * q[2] + q[0] * q[1]);
        let t4 = +1.0 - 2.0 * (ysqr + q[2] * q[2]);
        let roll = Math.atan2(t3, t4);
        return Math3D.vec3(pitch, yaw, roll);
    }
};

export function computeWorldAABB(localMin: number[] | Float32Array, localMax: number[] | Float32Array, matrix: number[] | Float32Array) {
    const corners = [
        [localMin[0], localMin[1], localMin[2]], [localMax[0], localMin[1], localMin[2]], 
        [localMin[0], localMax[1], localMin[2]], [localMax[0], localMax[1], localMin[2]], 
        [localMin[0], localMin[1], localMax[2]], [localMax[0], localMin[1], localMax[2]], 
        [localMin[0], localMax[1], localMax[2]], [localMax[0], localMax[1], localMax[2]]
    ];
    let wMin = [99999, 99999, 99999], wMax = [-99999, -99999, -99999];
    for (let c of corners) {
        let x = c[0] * matrix[0] + c[1] * matrix[4] + c[2] * matrix[8] + matrix[12];
        let y = c[0] * matrix[1] + c[1] * matrix[5] + c[2] * matrix[9] + matrix[13];
        let z = c[0] * matrix[2] + c[1] * matrix[6] + c[2] * matrix[10] + matrix[14];
        wMin[0] = Math.min(wMin[0], x); wMin[1] = Math.min(wMin[1], y); wMin[2] = Math.min(wMin[2], z);
        wMax[0] = Math.max(wMax[0], x); wMax[1] = Math.max(wMax[1], y); wMax[2] = Math.max(wMax[2], z);
    }
    return { min: wMin, max: wMax };
}
