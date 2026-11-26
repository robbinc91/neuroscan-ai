/**
 * Volume filters: separable 3D Gaussian, cubic median, tiled CLAHE, Chambolle TV.
 * Neighbors are in voxel index space; borders use reflect (Gaussian) or clamp (median).
 */

export async function gaussianSmooth3D(
    data: ArrayLike<number>,
    dimensions: [number, number, number],
    sigmaVoxels: number | [number, number, number],
    onProgress?: (pct: number) => void | Promise<void>
): Promise<Float32Array> {
    const [width, height, depth] = dimensions;
    const len = width * height * depth;
    if (data.length !== len) {
        throw new Error('Gaussian: volume length does not match dimensions');
    }

    const [sx, sy, sz] = Array.isArray(sigmaVoxels)
        ? [Math.max(0.15, sigmaVoxels[0]), Math.max(0.15, sigmaVoxels[1]), Math.max(0.15, sigmaVoxels[2])]
        : [Math.max(0.15, sigmaVoxels), Math.max(0.15, sigmaVoxels), Math.max(0.15, sigmaVoxels)];
    const src = new Float32Array(len);
    src.set(data as ArrayLike<number>);
    const tmp = new Float32Array(len);
    const dst = new Float32Array(len);

    await convolveAxis(src, tmp, width, height, depth, 'x', gaussianKernel(sx), onProgress, 0, 33);
    await convolveAxis(tmp, dst, width, height, depth, 'y', gaussianKernel(sy), onProgress, 33, 66);
    await convolveAxis(dst, tmp, width, height, depth, 'z', gaussianKernel(sz), onProgress, 66, 100);
    return tmp;
}

/**
 * Contrast-Limited Adaptive Histogram Equalization on each axial slice.
 * Tiles compute clipped CDFs; pixel values are bilinear blends of neighboring LUTs
 * (OpenCV CLAHE). clipLimit is a relative cap: clip = clipLimit * (tilePixels / 256).
 */
export async function claheVolume(
    data: ArrayLike<number>,
    dimensions: [number, number, number],
    clipLimit: number,
    tileGrid: number,
    intensityMin: number,
    intensityMax: number,
    onProgress?: (pct: number) => void | Promise<void>
): Promise<Float32Array> {
    const [width, height, depth] = dimensions;
    const len = width * height * depth;
    if (data.length !== len) {
        throw new Error('CLAHE: volume length does not match dimensions');
    }

    const tiles = Math.max(2, Math.min(16, Math.round(tileGrid) || 8));
    const clip = Math.max(0.1, clipLimit);
    const range = intensityMax - intensityMin || 1;
    const out = new Float32Array(len);
    const sliceLen = width * height;
    const slice = new Float32Array(sliceLen);

    for (let z = 0; z < depth; z++) {
        const zOff = z * sliceLen;
        for (let i = 0; i < sliceLen; i++) slice[i] = data[zOff + i];
        claheSlice(slice, width, height, out, zOff, clip, tiles, intensityMin, range);
        if (z % 2 === 0 || z === depth - 1) {
            await report(onProgress, Math.round(((z + 1) / depth) * 100));
        }
    }
    return out;
}

/**
 * 3D ROF / Chambolle TV-L2 denoise. `weight` is λ (higher = closer to the original).
 * Intensities are mapped to [0, 1] for the iteration, then restored.
 */
export async function tvDenoise3D(
    data: ArrayLike<number>,
    dimensions: [number, number, number],
    weight: number,
    iterations: number,
    onProgress?: (pct: number) => void | Promise<void>
): Promise<Float32Array> {
    const [width, height, depth] = dimensions;
    const len = width * height * depth;
    if (data.length !== len) {
        throw new Error('TV denoise: volume length does not match dimensions');
    }

    let vmin = Infinity;
    let vmax = -Infinity;
    for (let i = 0; i < len; i++) {
        const v = data[i];
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
    }
    if (!Number.isFinite(vmin)) {
        const empty = new Float32Array(len);
        return empty;
    }
    const range = vmax - vmin || 1;
    const lam = Math.max(1e-3, weight);
    const nIter = Math.max(1, Math.min(80, Math.round(iterations)));
    const tau = 1 / 12;

    const f = new Float32Array(len);
    for (let i = 0; i < len; i++) f[i] = (data[i] - vmin) / range;

    const px = new Float32Array(len);
    const py = new Float32Array(len);
    const pz = new Float32Array(len);
    const div = new Float32Array(len);
    const slice = width * height;

    for (let iter = 0; iter < nIter; iter++) {
        for (let z = 0; z < depth; z++) {
            const zOff = z * slice;
            for (let y = 0; y < height; y++) {
                const row = zOff + y * width;
                for (let x = 0; x < width; x++) {
                    const i = row + x;
                    let dv = 0;
                    if (x === 0) dv += px[i];
                    else if (x === width - 1) dv -= px[i - 1];
                    else dv += px[i] - px[i - 1];
                    if (y === 0) dv += py[i];
                    else if (y === height - 1) dv -= py[i - width];
                    else dv += py[i] - py[i - width];
                    if (z === 0) dv += pz[i];
                    else if (z === depth - 1) dv -= pz[i - slice];
                    else dv += pz[i] - pz[i - slice];
                    div[i] = dv;
                }
            }
        }

        for (let z = 0; z < depth; z++) {
            const zOff = z * slice;
            for (let y = 0; y < height; y++) {
                const row = zOff + y * width;
                for (let x = 0; x < width; x++) {
                    const i = row + x;
                    const u = div[i] - f[i] / lam;
                    const gx = x < width - 1 ? (div[i + 1] - f[i + 1] / lam) - u : 0;
                    const gy = y < height - 1 ? (div[i + width] - f[i + width] / lam) - u : 0;
                    const gz = z < depth - 1 ? (div[i + slice] - f[i + slice] / lam) - u : 0;
                    let qx = px[i] + tau * gx;
                    let qy = py[i] + tau * gy;
                    let qz = pz[i] + tau * gz;
                    const mag = Math.hypot(qx, qy, qz);
                    if (mag > 1) {
                        qx /= mag;
                        qy /= mag;
                        qz /= mag;
                    }
                    px[i] = qx;
                    py[i] = qy;
                    pz[i] = qz;
                }
            }
        }
        await report(onProgress, Math.round(((iter + 1) / nIter) * 100));
    }

    for (let z = 0; z < depth; z++) {
        const zOff = z * slice;
        for (let y = 0; y < height; y++) {
            const row = zOff + y * width;
            for (let x = 0; x < width; x++) {
                const i = row + x;
                let dv = 0;
                if (x === 0) dv += px[i];
                else if (x === width - 1) dv -= px[i - 1];
                else dv += px[i] - px[i - 1];
                if (y === 0) dv += py[i];
                else if (y === height - 1) dv -= py[i - width];
                else dv += py[i] - py[i - width];
                if (z === 0) dv += pz[i];
                else if (z === depth - 1) dv -= pz[i - slice];
                else dv += pz[i] - pz[i - slice];
                f[i] = vmin + Math.min(1, Math.max(0, f[i] - lam * dv)) * range;
            }
        }
    }
    return f;
}

function claheSlice(
    src: Float32Array,
    width: number,
    height: number,
    out: Float32Array,
    offset: number,
    clipLimit: number,
    tiles: number,
    intensityMin: number,
    range: number
) {
    const tilesX = Math.max(2, Math.min(tiles, width));
    const tilesY = Math.max(2, Math.min(tiles, height));
    const tileW = Math.ceil(width / tilesX);
    const tileH = Math.ceil(height / tilesY);
    const luts = new Float32Array(tilesX * tilesY * 256);
    const hist = new Float32Array(256);

    for (let ty = 0; ty < tilesY; ty++) {
        const y0 = ty * tileH;
        const y1 = Math.min(height, y0 + tileH);
        for (let tx = 0; tx < tilesX; tx++) {
            const x0 = tx * tileW;
            const x1 = Math.min(width, x0 + tileW);
            hist.fill(0);
            let count = 0;
            for (let y = y0; y < y1; y++) {
                const row = y * width;
                for (let x = x0; x < x1; x++) {
                    const v = src[row + x];
                    const bin = Math.max(0, Math.min(255, Math.floor(((v - intensityMin) / range) * 255)));
                    hist[bin]++;
                    count++;
                }
            }
            if (count < 1) count = 1;
            const clip = Math.max(1, clipLimit * (count / 256));
            let excess = 0;
            for (let b = 0; b < 256; b++) {
                if (hist[b] > clip) {
                    excess += hist[b] - clip;
                    hist[b] = clip;
                }
            }
            const batch = Math.floor(excess / 256);
            let residual = excess - batch * 256;
            for (let b = 0; b < 256; b++) hist[b] += batch;
            for (let b = 0; residual > 0; b = (b + 1) & 255, residual--) hist[b] += 1;

            let cdf = 0;
            let cdfMin = 0;
            const lutOff = (ty * tilesX + tx) * 256;
            for (let b = 0; b < 256; b++) {
                cdf += hist[b];
                if (cdfMin === 0 && cdf > 0) cdfMin = cdf;
                const denom = count - cdfMin || 1;
                luts[lutOff + b] = intensityMin + ((cdf - cdfMin) / denom) * range;
            }
        }
    }

    for (let y = 0; y < height; y++) {
        const ty = (y + 0.5) / tileH - 0.5;
        const ty0 = Math.floor(ty);
        const fy = ty - ty0;
        const tyA = ty0 < 0 ? 0 : ty0 > tilesY - 1 ? tilesY - 1 : ty0;
        const tyB = ty0 + 1 < 0 ? 0 : ty0 + 1 > tilesY - 1 ? tilesY - 1 : ty0 + 1;
        const row = y * width;
        for (let x = 0; x < width; x++) {
            const tx = (x + 0.5) / tileW - 0.5;
            const tx0 = Math.floor(tx);
            const fx = tx - tx0;
            const txA = tx0 < 0 ? 0 : tx0 > tilesX - 1 ? tilesX - 1 : tx0;
            const txB = tx0 + 1 < 0 ? 0 : tx0 + 1 > tilesX - 1 ? tilesX - 1 : tx0 + 1;
            const bin = Math.max(0, Math.min(255, Math.floor(((src[row + x] - intensityMin) / range) * 255)));
            const v00 = luts[(tyA * tilesX + txA) * 256 + bin];
            const v10 = luts[(tyA * tilesX + txB) * 256 + bin];
            const v01 = luts[(tyB * tilesX + txA) * 256 + bin];
            const v11 = luts[(tyB * tilesX + txB) * 256 + bin];
            out[offset + row + x] =
                (1 - fx) * (1 - fy) * v00 + fx * (1 - fy) * v10 + (1 - fx) * fy * v01 + fx * fy * v11;
        }
    }
}

export async function medianFilter3D(
    data: ArrayLike<number>,
    dimensions: [number, number, number],
    radius: number,
    onProgress?: (pct: number) => void | Promise<void>
): Promise<Float32Array> {
    const [width, height, depth] = dimensions;
    const len = width * height * depth;
    if (data.length !== len) {
        throw new Error('Median: volume length does not match dimensions');
    }

    const r = Math.max(1, Math.min(2, Math.round(radius)));
    const out = new Float32Array(len);
    const window = new Float32Array((2 * r + 1) ** 3);
    const slice = width * height;

    for (let z = 0; z < depth; z++) {
        for (let y = 0; y < height; y++) {
            const row = z * slice + y * width;
            for (let x = 0; x < width; x++) {
                let n = 0;
                for (let dz = -r; dz <= r; dz++) {
                    const zz = clampInt(z + dz, 0, depth - 1);
                    const zOff = zz * slice;
                    for (let dy = -r; dy <= r; dy++) {
                        const yy = clampInt(y + dy, 0, height - 1);
                        const yOff = zOff + yy * width;
                        for (let dx = -r; dx <= r; dx++) {
                            const xx = clampInt(x + dx, 0, width - 1);
                            window[n++] = data[yOff + xx];
                        }
                    }
                }
                out[row + x] = selectMedian(window, n);
            }
        }
        if (z % 2 === 0 || z === depth - 1) {
            await report(onProgress, Math.round(((z + 1) / depth) * 100));
        }
    }
    return out;
}

/**
 * Local adaptive threshold (Gaussian), applied per axial slice.
 *
 * Matches OpenCV ADAPTIVE_THRESH_GAUSSIAN_C / skimage.threshold_local:
 *   T(x,y) = gaussian_mean_ksize(x,y) - offset
 * A voxel is labeled 1 when intensity > T.
 *
 * Uniform dark background also satisfies intensity ≈ mean, so a volume Otsu
 * gate keeps only neighborhoods brighter than the global split (tissue vs air
 * under a slow bias field). Label is always 0/1 — never the old stub's 3.
 *
 * `kernelSize` is the odd NxN window (sigma = (k-1)/6).
 * `offset` is C in intensity units (positive C → more inclusive).
 */
export async function localAdaptiveGaussianMask(
    data: ArrayLike<number>,
    dimensions: [number, number, number],
    kernelSize: number,
    offset: number,
    intensityMin: number,
    intensityMax: number,
    onProgress?: (pct: number) => void | Promise<void>
): Promise<Uint8Array> {
    const [width, height, depth] = dimensions;
    const len = width * height * depth;
    if (data.length !== len) {
        throw new Error('Local adaptive: volume length does not match dimensions');
    }

    const k = Math.max(3, Math.round(kernelSize) | 1);
    const sigma = Math.max(0.15, (k - 1) / 6);
    const kernel = gaussianKernel(sigma);
    const c = Number.isFinite(offset) ? offset : 0;
    const otsu = otsuIntensity(data, intensityMin, intensityMax);
    const neighborhoodFloor = otsu;

    const mask = new Uint8Array(len);
    const sliceLen = width * height;
    const src = new Float32Array(sliceLen);
    const tmp = new Float32Array(sliceLen);
    const smooth = new Float32Array(sliceLen);

    await report(onProgress, 2);

    for (let z = 0; z < depth; z++) {
        const zOff = z * sliceLen;
        for (let i = 0; i < sliceLen; i++) src[i] = data[zOff + i];
        convolveSliceAxis(src, tmp, width, height, 'x', kernel);
        convolveSliceAxis(tmp, smooth, width, height, 'y', kernel);
        for (let i = 0; i < sliceLen; i++) {
            const mean = smooth[i];
            if (!(mean > neighborhoodFloor)) continue;
            if (src[i] > mean - c) mask[zOff + i] = 1;
        }
        if (z % 2 === 0 || z === depth - 1) {
            await report(onProgress, 2 + Math.round(((z + 1) / depth) * 98));
        }
    }
    return mask;
}

function otsuIntensity(data: ArrayLike<number>, min: number, max: number): number {
    const range = max - min || 1;
    const hist = new Int32Array(256);
    const len = data.length;
    const stride = len > 2_000_000 ? Math.floor(len / 500_000) : 1;
    let total = 0;
    for (let i = 0; i < len; i += stride) {
        const v = data[i];
        if (!Number.isFinite(v)) continue;
        const bin = Math.max(0, Math.min(255, Math.floor(((v - min) / range) * 255)));
        hist[bin]++;
        total++;
    }
    if (total < 2) return min + 0.5 * range;

    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0;
    let wB = 0;
    let maxVar = 0;
    let threshold = 0;
    for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (wB === 0) continue;
        const wF = total - wB;
        if (wF === 0) break;
        sumB += t * hist[t];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > maxVar) {
            maxVar = between;
            threshold = t;
        }
    }
    return min + (threshold / 255) * range;
}

function convolveSliceAxis(
    src: Float32Array,
    dst: Float32Array,
    width: number,
    height: number,
    axis: 'x' | 'y',
    kernel: Float32Array
) {
    const radius = (kernel.length - 1) >> 1;
    if (axis === 'x') {
        for (let y = 0; y < height; y++) {
            const row = y * width;
            for (let x = 0; x < width; x++) {
                let acc = 0;
                for (let k = -radius; k <= radius; k++) {
                    acc += src[row + reflectIndex(x + k, width)] * kernel[k + radius];
                }
                dst[row + x] = acc;
            }
        }
        return;
    }
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            let acc = 0;
            for (let k = -radius; k <= radius; k++) {
                acc += src[reflectIndex(y + k, height) * width + x] * kernel[k + radius];
            }
            dst[y * width + x] = acc;
        }
    }
}

function gaussianKernel(sigma: number): Float32Array {
    const radius = Math.max(1, Math.ceil(3 * sigma));
    const k = new Float32Array(2 * radius + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
        const w = Math.exp(-0.5 * (i / sigma) * (i / sigma));
        k[i + radius] = w;
        sum += w;
    }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    return k;
}

type Axis = 'x' | 'y' | 'z';

async function convolveAxis(
    src: Float32Array,
    dst: Float32Array,
    width: number,
    height: number,
    depth: number,
    axis: Axis,
    kernel: Float32Array,
    onProgress: ((pct: number) => void | Promise<void>) | undefined,
    pct0: number,
    pct1: number
) {
    const radius = (kernel.length - 1) >> 1;
    const slice = width * height;

    if (axis === 'x') {
        for (let z = 0; z < depth; z++) {
            for (let y = 0; y < height; y++) {
                const row = z * slice + y * width;
                for (let x = 0; x < width; x++) {
                    let acc = 0;
                    for (let k = -radius; k <= radius; k++) {
                        acc += src[row + reflectIndex(x + k, width)] * kernel[k + radius];
                    }
                    dst[row + x] = acc;
                }
            }
            if (z % 4 === 0 || z === depth - 1) {
                await report(onProgress, pct0 + ((z + 1) / depth) * (pct1 - pct0));
            }
        }
        return;
    }

    if (axis === 'y') {
        for (let z = 0; z < depth; z++) {
            const zOff = z * slice;
            for (let x = 0; x < width; x++) {
                for (let y = 0; y < height; y++) {
                    let acc = 0;
                    for (let k = -radius; k <= radius; k++) {
                        const yy = reflectIndex(y + k, height);
                        acc += src[zOff + yy * width + x] * kernel[k + radius];
                    }
                    dst[zOff + y * width + x] = acc;
                }
            }
            if (z % 4 === 0 || z === depth - 1) {
                await report(onProgress, pct0 + ((z + 1) / depth) * (pct1 - pct0));
            }
        }
        return;
    }

    for (let y = 0; y < height; y++) {
        const yOff = y * width;
        for (let x = 0; x < width; x++) {
            for (let z = 0; z < depth; z++) {
                let acc = 0;
                for (let k = -radius; k <= radius; k++) {
                    const zz = reflectIndex(z + k, depth);
                    acc += src[zz * slice + yOff + x] * kernel[k + radius];
                }
                dst[z * slice + yOff + x] = acc;
            }
        }
        if (y % 4 === 0 || y === height - 1) {
            await report(onProgress, pct0 + ((y + 1) / height) * (pct1 - pct0));
        }
    }
}

/** Scipy 'reflect' indexing: mirror at the edge without duplicating the endpoint. */
function reflectIndex(i: number, n: number): number {
    if (n <= 1) return 0;
    const period = 2 * n - 2;
    let x = i % period;
    if (x < 0) x += period;
    return x < n ? x : period - x;
}

function clampInt(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

function selectMedian(values: Float32Array, n: number): number {
    const copy = values.subarray(0, n);
    copy.sort();
    const mid = n >> 1;
    if (n % 2 === 1) return copy[mid];
    return 0.5 * (copy[mid - 1] + copy[mid]);
}

async function report(onProgress: ((pct: number) => void | Promise<void>) | undefined, pct: number) {
    if (!onProgress) return;
    await onProgress(Math.max(0, Math.min(100, pct)));
}
