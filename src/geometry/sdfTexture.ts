// @ts-nocheck

export function createSDFTexture(device) {
                const size = 64;
                const data = new Uint8Array(size * size * 4);
                for (let y = 0; y < size; y++) {
                    for (let x = 0; x < size; x++) {
                        let u = (x / size) * 2 - 1; let v = (y / size) * 2 - 1;
                        let dist = Math.abs(Math.sqrt(u * u + v * v) - 0.5) - 0.15;
                        let val = 128 - dist * 255;
                        let c = Math.max(0, Math.min(255, val));
                        let i = (y * size + x) * 4;
                        data[i] = c; data[i + 1] = c; data[i + 2] = c; data[i + 3] = 255;
                    }
                }
                const texture = device.createTexture({
                    size: [size, size, 1], format: 'rgba8unorm',
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
                });
                device.queue.writeTexture({ texture }, data, { bytesPerRow: size * 4 }, [size, size, 1]);
                return texture;
            }