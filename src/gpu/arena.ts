// @ts-nocheck

export class GPUArena {
                constructor(device, label, initialCapacity, bytesPerElement, usage) {
                    this.device = device;
                    this.label = label;
                    this.bytesPerElement = bytesPerElement;
                    this.usage = usage;

                    // 1. Query the absolute hardware limit for this specific user's GPU
                    this.maxBytesAllowed = this.device.limits.maxStorageBufferBindingSize;
                    this.maxCapacity = Math.floor(this.maxBytesAllowed / this.bytesPerElement);

                    // 2. Start with a modest size, capped by the hardware limit
                    this.capacity = Math.min(initialCapacity, this.maxCapacity);

                    this._allocateCPU();
                    this._allocateGPU();
                }

                _allocateCPU(oldU8Array = null) {
                    this.cpuBuffer = new ArrayBuffer(this.capacity * this.bytesPerElement);

                    this.f32 = new Float32Array(this.cpuBuffer);
                    this.i32 = new Int32Array(this.cpuBuffer);
                    this.u32 = new Uint32Array(this.cpuBuffer);
                    this.u8 = new Uint8Array(this.cpuBuffer);

                    if (oldU8Array) {
                        this.u8.set(oldU8Array);
                    }
                }

                _allocateGPU() {
                    if (this.gpuBuffer) this.gpuBuffer.destroy();
                    this.gpuBuffer = this.device.createBuffer({
                        label: this.label,
                        size: this.capacity * this.bytesPerElement,
                        usage: this.usage
                    });
                }

                ensureCapacity(requiredElements) {
                    // If we have enough space, do nothing. (Fastest path, 0 cost)
                    if (requiredElements <= this.capacity) return false;

                    // 3. Graceful Hardware Limit checking
                    if (requiredElements > this.maxCapacity) {
                        console.error(`[Arena] FATAL: ${this.label} requires ${requiredElements} elements, but the hardware limit is ${this.maxCapacity}.`);
                        alert(`Your scene is too complex for this device's GPU limits. Reducing geometry is required.`);
                        return false; // Prevent WebGPU crash
                    }

                    const oldCapacity = this.capacity;

                    // 4. Grow by 1.5x, but NEVER exceed the physical GPU limit
                    this.capacity = Math.min(Math.ceil(requiredElements * 1.5), this.maxCapacity);
                    console.log(`[Arena] Expanding ${this.label}: ${oldCapacity} -> ${this.capacity} elements`);

                    const oldU8 = this.u8;
                    this._allocateCPU(oldU8);
                    this._allocateGPU();

                    return true; // Triggers BindGroup rebuilds in the engine
                }

                upload(queue, activeElements) {
                    if (activeElements === 0) return;
                    const activeBytes = activeElements * this.bytesPerElement;
                    queue.writeBuffer(this.gpuBuffer, 0, this.u8.subarray(0, activeBytes));
                }
            }