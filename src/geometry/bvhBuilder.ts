// @ts-nocheck

export function buildMeshBVH(meshTriangles, method = 'spatial') {
                let N = meshTriangles.length;
                if (N === 0) return { nodes: [{ min: [0, 0, 0], max: [0, 0, 0], leftFirst: 0, triCount: 0, parent: -1 }], triangles: [], order: new Uint32Array(0) };

                let bvhNodes = [];
                let triIndices = new Uint32Array(N);
                let centroids = new Float32Array(N * 3);

                for (let i = 0; i < N; i++) {
                    triIndices[i] = i;
                    let t = meshTriangles[i];
                    centroids[i * 3 + 0] = (t[0][0] + t[1][0] + t[2][0]) / 3;
                    centroids[i * 3 + 1] = (t[0][1] + t[1][1] + t[2][1]) / 3;
                    centroids[i * 3 + 2] = (t[0][2] + t[1][2] + t[2][2]) / 3;
                }

                let nodesUsed = 1;
                bvhNodes.push({ min: [0, 0, 0], max: [0, 0, 0], leftFirst: 0, triCount: N, parent: -1 });

                function updateNodeBounds(nodeIdx) {
                    let node = bvhNodes[nodeIdx];
                    let min = [99999, 99999, 99999], max = [-99999, -99999, -99999];
                    for (let i = 0; i < node.triCount; i++) {
                        let leafTriIdx = triIndices[node.leftFirst + i];
                        let tri = meshTriangles[leafTriIdx];
                        for (let v = 0; v < 3; v++) {
                            for (let axis = 0; axis < 3; axis++) {
                                min[axis] = Math.min(min[axis], tri[v][axis]);
                                max[axis] = Math.max(max[axis], tri[v][axis]);
                            }
                        }
                    }
                    node.min = min; node.max = max;
                }

                function getSurfaceArea(min, max) {
                    let ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
                    return 2.0 * (ext[0] * ext[1] + ext[1] * ext[2] + ext[2] * ext[0]);
                }

                function subdivide(nodeIdx) {
                    let node = bvhNodes[nodeIdx];
                    if (node.triCount <= 2) return;

                    let axis = 0;
                    let splitPos = 0;
                    let useSpatialFallback = (method === 'spatial');

                    if (method === 'sah') {
                        const BINS = 8;
                        let bestCost = Infinity;

                        // Find bounds of centroids to perfectly fit the bins
                        let cMin = [Infinity, Infinity, Infinity], cMax = [-Infinity, -Infinity, -Infinity];
                        for (let i = 0; i < node.triCount; i++) {
                            let cIdx = triIndices[node.leftFirst + i] * 3;
                            for (let a = 0; a < 3; a++) {
                                cMin[a] = Math.min(cMin[a], centroids[cIdx + a]);
                                cMax[a] = Math.max(cMax[a], centroids[cIdx + a]);
                            }
                        }

                        for (let a = 0; a < 3; a++) {
                            let bMin = cMin[a], bMax = cMax[a];
                            if (bMax - bMin < 0.0001) continue;

                            let binCounts = new Array(BINS).fill(0);
                            let binBoundsMin = Array.from({ length: BINS }, () => [Infinity, Infinity, Infinity]);
                            let binBoundsMax = Array.from({ length: BINS }, () => [-Infinity, -Infinity, -Infinity]);

                            for (let i = 0; i < node.triCount; i++) {
                                let triIdx = triIndices[node.leftFirst + i];
                                let c = centroids[triIdx * 3 + a];
                                let binIdx = Math.floor(BINS * ((c - bMin) / (bMax - bMin)));
                                binIdx = Math.min(BINS - 1, Math.max(0, binIdx));

                                binCounts[binIdx]++;
                                let tri = meshTriangles[triIdx];
                                for (let v = 0; v < 3; v++) {
                                    for (let ax = 0; ax < 3; ax++) {
                                        binBoundsMin[binIdx][ax] = Math.min(binBoundsMin[binIdx][ax], tri[v][ax]);
                                        binBoundsMax[binIdx][ax] = Math.max(binBoundsMax[binIdx][ax], tri[v][ax]);
                                    }
                                }
                            }

                            let leftArea = new Array(BINS - 1).fill(0);
                            let leftCount = new Array(BINS - 1).fill(0);
                            let lBoxMin = [Infinity, Infinity, Infinity], lBoxMax = [-Infinity, -Infinity, -Infinity];
                            let sumCount = 0;

                            for (let i = 0; i < BINS - 1; i++) {
                                sumCount += binCounts[i];
                                if (binCounts[i] > 0) {
                                    for (let ax = 0; ax < 3; ax++) {
                                        lBoxMin[ax] = Math.min(lBoxMin[ax], binBoundsMin[i][ax]);
                                        lBoxMax[ax] = Math.max(lBoxMax[ax], binBoundsMax[i][ax]);
                                    }
                                }
                                leftCount[i] = sumCount;
                                leftArea[i] = sumCount > 0 ? getSurfaceArea(lBoxMin, lBoxMax) : 0;
                            }

                            let rBoxMin = [Infinity, Infinity, Infinity], rBoxMax = [-Infinity, -Infinity, -Infinity];
                            sumCount = 0;

                            for (let i = BINS - 1; i > 0; i--) {
                                sumCount += binCounts[i];
                                if (binCounts[i] > 0) {
                                    for (let ax = 0; ax < 3; ax++) {
                                        rBoxMin[ax] = Math.min(rBoxMin[ax], binBoundsMin[i][ax]);
                                        rBoxMax[ax] = Math.max(rBoxMax[ax], binBoundsMax[i][ax]);
                                    }
                                }
                                let rightArea = sumCount > 0 ? getSurfaceArea(rBoxMin, rBoxMax) : 0;

                                // SAH Cost Formula
                                let cost = leftArea[i - 1] * leftCount[i - 1] + rightArea * sumCount;

                                if (cost < bestCost) {
                                    bestCost = cost;
                                    axis = a;
                                    splitPos = bMin + (i / BINS) * (bMax - bMin);
                                }
                            }
                        }
                        if (bestCost === Infinity) useSpatialFallback = true;
                    }

                    if (useSpatialFallback) {
                        let extents = [node.max[0] - node.min[0], node.max[1] - node.min[1], node.max[2] - node.min[2]];
                        if (extents[1] > extents[0]) axis = 1;
                        if (extents[2] > extents[axis]) axis = 2;
                        splitPos = node.min[axis] + extents[axis] * 0.5;
                    }

                    // Apply chosen split
                    let i = node.leftFirst, j = i + node.triCount - 1;
                    while (i <= j) {
                        let triIdx = triIndices[i];
                        if (centroids[triIdx * 3 + axis] < splitPos) { i++; }
                        else {
                            let temp = triIndices[i];
                            triIndices[i] = triIndices[j];
                            triIndices[j] = temp;
                            j--;
                        }
                    }

                    let leftCount = i - node.leftFirst;
                    if (leftCount == 0 || leftCount == node.triCount) {
                        leftCount = Math.floor(node.triCount / 2);
                        i = node.leftFirst + leftCount;
                    }

                    let leftChildIdx = nodesUsed++;
                    let rightChildIdx = nodesUsed++;

                    bvhNodes[leftChildIdx] = { min: [0, 0, 0], max: [0, 0, 0], leftFirst: node.leftFirst, triCount: leftCount, parent: nodeIdx };
                    bvhNodes[rightChildIdx] = { min: [0, 0, 0], max: [0, 0, 0], leftFirst: i, triCount: node.triCount - leftCount, parent: nodeIdx };

                    node.leftFirst = leftChildIdx;
                    node.triCount = 0;

                    updateNodeBounds(leftChildIdx);
                    updateNodeBounds(rightChildIdx);

                    subdivide(leftChildIdx);
                    subdivide(rightChildIdx);
                }

                updateNodeBounds(0);
                subdivide(0);

                let orderedTriangles = [];
                for (let i = 0; i < N; i++) { orderedTriangles.push(meshTriangles[triIndices[i]]); }
                return { nodes: bvhNodes, triangles: orderedTriangles, order: triIndices };
            }