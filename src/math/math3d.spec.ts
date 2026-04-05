import { describe, it, expect } from 'vitest';
import { Math3D } from './math3d';

describe('Math3D', () => {
    it('should create vec3 correctly', () => {
        const v = Math3D.vec3(1, 2, 3);
        expect(v[0]).toBe(1);
        expect(v[1]).toBe(2);
        expect(v[2]).toBe(3);
    });

    it('should add vectors', () => {
        const a = Math3D.vec3(1, 2, 3);
        const b = Math3D.vec3(4, 5, 6);
        const result = Math3D.add(a, b);
        expect(result[0]).toBe(5);
        expect(result[1]).toBe(7);
        expect(result[2]).toBe(9);
    });

    it('should calculate length', () => {
        const v = Math3D.vec3(3, 4, 0);
        expect(Math3D.length(v)).toBe(5);
    });

    it('should normalize vectors', () => {
        const v = Math3D.vec3(3, 0, 0);
        const result = Math3D.normalize(v);
        expect(result[0]).toBe(1);
        expect(Math3D.length(result)).toBe(1);
    });
});
