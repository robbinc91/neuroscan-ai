import type { VolumeData } from '../types';
import { tryItkWasmN4 } from './n4ItkWasm';

/**
 * Hierarchical N4-style bias field correction (Tustison 2010; N3 residual step from Sled 1998).
 *
 * Pipeline:
 *  1. Otsu foreground mask (non-positive voxels excluded)
 *  2. Shrink the working grid (ITK N4 default shrink ≈ 4)
 *  3. Iterate in log intensity: Wiener-deconvolve the residual histogram, then fit a
 *     cubic B-spline to (log image − sharpened residual)
 *  4. Refine with more control points at each level
 *  5. Upsample the log-bias and divide it out of the original volume
 *
 * This is not the ITK binary, but it is the N4 model — not a geometric vignette.
 */

export interface N4Options {
    /** B-spline knot spacing in mm at the finest level. Default 50. */
    meshSpacingMm?: number;
    /** Iterations at each hierarchical level. Default 8. */
    iterationsPerLevel?: number;
    /** Number of coarse-to-fine spline levels. Default 3. */
    numberOfLevels?: number;
    /** Extra spline level + try ITK-WASM N4 if that package is installed. */
    highAccuracy?: boolean;
    /** Histogram Gaussian FWHM in log-intensity units. Default 0.15. */
    fwhm?: number;
    /** Wiener noise term. Default 0.01. */
    wienerNoise?: number;
    /** Stop a level early when RMS log-bias update falls below this. Default 0.001. */
    convergenceThreshold?: number;
}

export interface N4Result {
    data: Float32Array;
    min: number;
    max: number;
}

const HIST_BINS = 256;
const LOG_EPS = 1e-6;
const FWHM_TO_SIGMA = 1 / (2 * Math.sqrt(2 * Math.log(2)));

type Vec3 = [number, number, number];

interface AxisSupport {
    idx: Int16Array;
    w: Float32Array;
}

export async function correctN4BiasField(
    volume: VolumeData,
    options: N4Options = {},
    onProgress?: (pct: number) => void | Promise<void>
): Promise<N4Result> {
    const meshSpacingMm = clamp(options.meshSpacingMm ?? 50, 15, 150);
    const iterationsPerLevel = Math.max(1, Math.round(options.iterationsPerLevel ?? 8));
    const numberOfLevels = Math.max(1, Math.min(4, Math.round(options.numberOfLevels ?? (options.highAccuracy ? 4 : 3))));

    if (options.highAccuracy) {
        const itk = await tryItkWasmN4(volume, {
            meshSpacingMm,
            iterationsPerLevel,
            fwhm: options.fwhm,
            wienerNoise: options.wienerNoise,
            convergenceThreshold: options.convergenceThreshold
        }, onProgress);
        if (itk) return itk;
    }
    const fwhm = options.fwhm ?? 0.15;
    const wienerNoise = options.wienerNoise ?? 0.01;
    const convergenceThreshold = options.convergenceThreshold ?? 0.001;

    const dims = volume.dimensions;
    const [width, height, depth] = dims;
    const src = volume.data;
    const len = src.length;
    if (len !== width * height * depth) {
        throw new Error('N4: volume length does not match dimensions');
    }

    await report(onProgress, 2);

    const spacing = voxelSpacingMm(volume);
    const mask = buildForegroundMask(src, volume.min, volume.max);
    let maskCount = 0;
    for (let i = 0; i < len; i++) if (mask[i]) maskCount++;
    if (maskCount < 64) {
        throw new Error('N4: not enough foreground voxels to estimate a bias field');
    }

    const shrink = chooseShrinkFactor(dims);
    const workDims = shrinkDims(dims, shrink);
    const logImage = shrinkMaskedLog(src, mask, dims, workDims, shrink);
    const workMask = shrinkMask(mask, dims, workDims, shrink);
    const workLen = workDims[0] * workDims[1] * workDims[2];
    const logBias = new Float32Array(workLen);

    const fovMm: Vec3 = [
        Math.max(1, (workDims[0] - 1) * spacing[0] * shrink),
        Math.max(1, (workDims[1] - 1) * spacing[1] * shrink),
        Math.max(1, (workDims[2] - 1) * spacing[2] * shrink)
    ];
    const targetNcp: Vec3 = [
        clamp(Math.round(fovMm[0] / meshSpacingMm) + 3, 4, 16),
        clamp(Math.round(fovMm[1] / meshSpacingMm) + 3, 4, 16),
        clamp(Math.round(fovMm[2] / meshSpacingMm) + 3, 4, 16)
    ];

    await report(onProgress, 8);

    const totalIters = numberOfLevels * iterationsPerLevel;
    let finishedIters = 0;

    for (let level = 0; level < numberOfLevels; level++) {
        const ncp: Vec3 = [
            ncpForLevel(level, numberOfLevels, targetNcp[0]),
            ncpForLevel(level, numberOfLevels, targetNcp[1]),
            ncpForLevel(level, numberOfLevels, targetNcp[2])
        ];
        const support = precomputeSplineSupport(workDims, ncp);
        const residual = new Float32Array(workLen);
        const observed = new Float32Array(workLen);

        for (let iter = 0; iter < iterationsPerLevel; iter++) {
            for (let i = 0; i < workLen; i++) {
                if (!workMask[i]) continue;
                residual[i] = logImage[i] - logBias[i];
            }

            const sharpened = sharpenResidualHistogram(residual, workMask, fwhm, wienerNoise);
            for (let i = 0; i < workLen; i++) {
                if (!workMask[i]) {
                    observed[i] = logBias[i];
                } else {
                    observed[i] = logImage[i] - sharpened[i];
                }
            }

            const fitted = fitCubicBSplineField(observed, workMask, workDims, ncp, support);
            let rms = 0;
            let n = 0;
            for (let i = 0; i < workLen; i++) {
                if (!workMask[i]) continue;
                const d = fitted[i] - logBias[i];
                rms += d * d;
                n++;
                logBias[i] = fitted[i];
            }
            rms = n > 0 ? Math.sqrt(rms / n) : 0;

            finishedIters++;
            const pct = 8 + Math.round((finishedIters / totalIters) * 82);
            await report(onProgress, pct);

            if (rms < convergenceThreshold) break;
        }
    }

    await report(onProgress, 92);

    const fullBias = upsampleTrilinear(logBias, workDims, dims);
    const out = new Float32Array(len);
    let sumOrig = 0;
    let sumCorr = 0;
    let nFg = 0;

    for (let i = 0; i < len; i++) {
        const v = src[i];
        if (!mask[i]) {
            out[i] = v;
            continue;
        }
        const corrected = v * Math.exp(-fullBias[i]);
        out[i] = corrected;
        sumOrig += v;
        sumCorr += corrected;
        nFg++;
    }

    if (nFg > 0 && sumCorr > LOG_EPS) {
        const scale = sumOrig / sumCorr;
        for (let i = 0; i < len; i++) {
            if (mask[i]) out[i] *= scale;
        }
    }

    let newMin = Infinity;
    let newMax = -Infinity;
    for (let i = 0; i < len; i++) {
        const v = out[i];
        if (v < newMin) newMin = v;
        if (v > newMax) newMax = v;
    }

    await report(onProgress, 100);
    return { data: out, min: newMin, max: newMax };
}

export function voxelSpacingMm(volume: VolumeData): Vec3 {
    const a = volume.affine;
    if (a && a.length >= 16) {
        const sx = Math.hypot(a[0], a[4], a[8]);
        const sy = Math.hypot(a[1], a[5], a[9]);
        const sz = Math.hypot(a[2], a[6], a[10]);
        if (sx > 1e-6 && sy > 1e-6 && sz > 1e-6) return [sx, sy, sz];
    }
    const pix = volume.header?.pixDims as number[] | undefined;
    return [
        Math.abs(pix?.[1]) || 1,
        Math.abs(pix?.[2]) || 1,
        Math.abs(pix?.[3]) || 1
    ];
}

function chooseShrinkFactor(dims: Vec3): number {
    const n = dims[0] * dims[1] * dims[2];
    if (n > 16_000_000) return 8;
    if (n > 1_000_000) return 4;
    if (n > 160_000) return 2;
    return 1;
}

function shrinkDims(dims: Vec3, factor: number): Vec3 {
    if (factor <= 1) return [dims[0], dims[1], dims[2]];
    return [
        Math.max(1, Math.floor(dims[0] / factor)),
        Math.max(1, Math.floor(dims[1] / factor)),
        Math.max(1, Math.floor(dims[2] / factor))
    ];
}

function buildForegroundMask(
    data: VolumeData['data'],
    min: number,
    max: number
): Uint8Array {
    const len = data.length;
    const mask = new Uint8Array(len);
    const range = max - min || 1;
    const hist = new Int32Array(256);
    const stride = len > 2_000_000 ? Math.floor(len / 500_000) : 1;
    let sampled = 0;

    for (let i = 0; i < len; i += stride) {
        const v = data[i];
        if (!Number.isFinite(v)) continue;
        const bin = Math.max(0, Math.min(255, Math.floor(((v - min) / range) * 255)));
        hist[bin]++;
        sampled++;
    }

    const tBin = sampled > 0 ? otsuThreshold(hist, sampled) : 0;
    const threshold = min + (tBin / 255) * range;

    for (let i = 0; i < len; i++) {
        const v = data[i];
        mask[i] = v > 0 && v >= threshold && Number.isFinite(v) ? 1 : 0;
    }

    let fg = 0;
    for (let i = 0; i < len; i++) fg += mask[i];
    if (fg < 64) {
        for (let i = 0; i < len; i++) {
            const v = data[i];
            mask[i] = v > 0 && Number.isFinite(v) ? 1 : 0;
        }
    }
    return mask;
}

function otsuThreshold(histogram: Int32Array, total: number): number {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * histogram[i];

    let sumB = 0;
    let wB = 0;
    let maxVar = 0;
    let threshold = 0;

    for (let t = 0; t < 256; t++) {
        wB += histogram[t];
        if (wB === 0) continue;
        const wF = total - wB;
        if (wF === 0) break;
        sumB += t * histogram[t];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > maxVar) {
            maxVar = between;
            threshold = t;
        }
    }
    return threshold;
}

function shrinkMaskedLog(
    data: VolumeData['data'],
    mask: Uint8Array,
    srcDims: Vec3,
    outDims: Vec3,
    factor: number
): Float32Array {
    const [w, h] = srcDims;
    const [ow, oh, od] = outDims;
    const out = new Float32Array(ow * oh * od);
    if (factor <= 1) {
        for (let i = 0; i < data.length; i++) {
            const v = data[i];
            out[i] = mask[i] && v > 0 ? Math.log(Math.max(v, LOG_EPS)) : 0;
        }
        return out;
    }

    const srcSlice = w * h;
    for (let z = 0; z < od; z++) {
        for (let y = 0; y < oh; y++) {
            for (let x = 0; x < ow; x++) {
                let sum = 0;
                let count = 0;
                for (let dz = 0; dz < factor; dz++) {
                    const iz = z * factor + dz;
                    if (iz >= srcDims[2]) break;
                    for (let dy = 0; dy < factor; dy++) {
                        const iy = y * factor + dy;
                        if (iy >= h) break;
                        const row = iz * srcSlice + iy * w;
                        for (let dx = 0; dx < factor; dx++) {
                            const ix = x * factor + dx;
                            if (ix >= w) break;
                            const idx = row + ix;
                            if (!mask[idx]) continue;
                            const v = data[idx];
                            if (v > 0) {
                                sum += Math.log(Math.max(v, LOG_EPS));
                                count++;
                            }
                        }
                    }
                }
                out[z * ow * oh + y * ow + x] = count > 0 ? sum / count : 0;
            }
        }
    }
    return out;
}

function shrinkMask(
    mask: Uint8Array,
    srcDims: Vec3,
    outDims: Vec3,
    factor: number
): Uint8Array {
    const [w, h] = srcDims;
    const [ow, oh, od] = outDims;
    const out = new Uint8Array(ow * oh * od);
    if (factor <= 1) {
        out.set(mask);
        return out;
    }

    const srcSlice = w * h;
    for (let z = 0; z < od; z++) {
        for (let y = 0; y < oh; y++) {
            for (let x = 0; x < ow; x++) {
                let fg = 0;
                let count = 0;
                for (let dz = 0; dz < factor; dz++) {
                    const iz = z * factor + dz;
                    if (iz >= srcDims[2]) break;
                    for (let dy = 0; dy < factor; dy++) {
                        const iy = y * factor + dy;
                        if (iy >= h) break;
                        const row = iz * srcSlice + iy * w;
                        for (let dx = 0; dx < factor; dx++) {
                            const ix = x * factor + dx;
                            if (ix >= w) break;
                            fg += mask[row + ix];
                            count++;
                        }
                    }
                }
                out[z * ow * oh + y * ow + x] = count > 0 && fg / count >= 0.5 ? 1 : 0;
            }
        }
    }
    return out;
}

function upsampleTrilinear(src: Float32Array, srcDims: Vec3, dstDims: Vec3): Float32Array {
    const [sw, sh, sd] = srcDims;
    const [dw, dh, dd] = dstDims;
    const dst = new Float32Array(dw * dh * dd);
    if (sw === dw && sh === dh && sd === dd) {
        dst.set(src);
        return dst;
    }

    const scaleX = sw === 1 ? 0 : (sw - 1) / Math.max(1, dw - 1);
    const scaleY = sh === 1 ? 0 : (sh - 1) / Math.max(1, dh - 1);
    const scaleZ = sd === 1 ? 0 : (sd - 1) / Math.max(1, dd - 1);
    const srcSlice = sw * sh;
    const dstSlice = dw * dh;

    for (let z = 0; z < dd; z++) {
        const fz = z * scaleZ;
        const z0 = Math.floor(fz);
        const z1 = Math.min(sd - 1, z0 + 1);
        const tz = fz - z0;
        for (let y = 0; y < dh; y++) {
            const fy = y * scaleY;
            const y0 = Math.floor(fy);
            const y1 = Math.min(sh - 1, y0 + 1);
            const ty = fy - y0;
            const dstRow = z * dstSlice + y * dw;
            for (let x = 0; x < dw; x++) {
                const fx = x * scaleX;
                const x0 = Math.floor(fx);
                const x1 = Math.min(sw - 1, x0 + 1);
                const tx = fx - x0;

                const c000 = src[z0 * srcSlice + y0 * sw + x0];
                const c100 = src[z0 * srcSlice + y0 * sw + x1];
                const c010 = src[z0 * srcSlice + y1 * sw + x0];
                const c110 = src[z0 * srcSlice + y1 * sw + x1];
                const c001 = src[z1 * srcSlice + y0 * sw + x0];
                const c101 = src[z1 * srcSlice + y0 * sw + x1];
                const c011 = src[z1 * srcSlice + y1 * sw + x0];
                const c111 = src[z1 * srcSlice + y1 * sw + x1];

                const c00 = c000 * (1 - tx) + c100 * tx;
                const c10 = c010 * (1 - tx) + c110 * tx;
                const c01 = c001 * (1 - tx) + c101 * tx;
                const c11 = c011 * (1 - tx) + c111 * tx;
                dst[dstRow + x] = (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
            }
        }
    }
    return dst;
}

function ncpForLevel(level: number, nLevels: number, target: number): number {
    if (nLevels <= 1) return target;
    const t = level / (nLevels - 1);
    return Math.max(4, Math.round(4 + t * (target - 4)));
}

function splineParam(x: number, size: number, ncp: number): number {
    if (size <= 1 || ncp <= 1) return 0;
    return (x / (size - 1)) * (ncp - 1);
}

function cubicBSplineWeights(u: number): [number, number, number, number] {
    const u2 = u * u;
    const u3 = u2 * u;
    return [
        (1 - 3 * u + 3 * u2 - u3) / 6,
        (3 * u3 - 6 * u2 + 4) / 6,
        (-3 * u3 + 3 * u2 + 3 * u + 1) / 6,
        u3 / 6
    ];
}

function precomputeAxisSupport(size: number, ncp: number): AxisSupport[] {
    const out: AxisSupport[] = new Array(size);
    const last = ncp - 1;
    for (let x = 0; x < size; x++) {
        const t = splineParam(x, size, ncp);
        const base = Math.floor(t);
        const w = cubicBSplineWeights(t - base);
        const idx = new Int16Array(4);
        const ww = new Float32Array(4);
        for (let k = 0; k < 4; k++) {
            idx[k] = Math.max(0, Math.min(last, base - 1 + k));
            ww[k] = w[k];
        }
        out[x] = { idx, w: ww };
    }
    return out;
}

function precomputeSplineSupport(dims: Vec3, ncp: Vec3): [AxisSupport[], AxisSupport[], AxisSupport[]] {
    return [
        precomputeAxisSupport(dims[0], ncp[0]),
        precomputeAxisSupport(dims[1], ncp[1]),
        precomputeAxisSupport(dims[2], ncp[2])
    ];
}

function splatToCoefficients(
    field: Float32Array,
    mask: Uint8Array,
    dims: Vec3,
    ncp: Vec3,
    support: [AxisSupport[], AxisSupport[], AxisSupport[]]
): Float64Array {
    const [w, h, d] = dims;
    const nGrid = ncp[0] * ncp[1] * ncp[2];
    const acc = new Float64Array(nGrid);
    const wt = new Float64Array(nGrid);
    const [sx, sy, sz] = support;
    const ncx = ncp[0];
    const ncy = ncp[1];

    for (let z = 0; z < d; z++) {
        const zs = sz[z];
        for (let y = 0; y < h; y++) {
            const ys = sy[y];
            const row = z * w * h + y * w;
            for (let x = 0; x < w; x++) {
                const idx = row + x;
                if (!mask[idx]) continue;
                const val = field[idx];
                const xs = sx[x];
                for (let kz = 0; kz < 4; kz++) {
                    const wz = zs.w[kz];
                    const gz = zs.idx[kz] * ncy * ncx;
                    for (let ky = 0; ky < 4; ky++) {
                        const wy = ys.w[ky] * wz;
                        const gy = gz + ys.idx[ky] * ncx;
                        for (let kx = 0; kx < 4; kx++) {
                            const ww = xs.w[kx] * wy;
                            const gi = gy + xs.idx[kx];
                            acc[gi] += ww * val;
                            wt[gi] += ww;
                        }
                    }
                }
            }
        }
    }

    for (let i = 0; i < nGrid; i++) {
        acc[i] = wt[i] > 1e-8 ? acc[i] / wt[i] : 0;
    }
    return acc;
}

function reconstructFromCoefficients(
    coeff: Float64Array,
    dims: Vec3,
    ncp: Vec3,
    support: [AxisSupport[], AxisSupport[], AxisSupport[]],
    out: Float32Array
) {
    const [w, h, d] = dims;
    const [sx, sy, sz] = support;
    const ncx = ncp[0];
    const ncy = ncp[1];

    for (let z = 0; z < d; z++) {
        const zs = sz[z];
        for (let y = 0; y < h; y++) {
            const ys = sy[y];
            const row = z * w * h + y * w;
            for (let x = 0; x < w; x++) {
                const xs = sx[x];
                let sum = 0;
                for (let kz = 0; kz < 4; kz++) {
                    const wz = zs.w[kz];
                    const gz = zs.idx[kz] * ncy * ncx;
                    for (let ky = 0; ky < 4; ky++) {
                        const wy = ys.w[ky] * wz;
                        const gy = gz + ys.idx[ky] * ncx;
                        for (let kx = 0; kx < 4; kx++) {
                            sum += coeff[gy + xs.idx[kx]] * xs.w[kx] * wy;
                        }
                    }
                }
                out[row + x] = sum;
            }
        }
    }
}

function fitCubicBSplineField(
    field: Float32Array,
    mask: Uint8Array,
    dims: Vec3,
    ncp: Vec3,
    support: [AxisSupport[], AxisSupport[], AxisSupport[]]
): Float32Array {
    const nVox = dims[0] * dims[1] * dims[2];
    const nGrid = ncp[0] * ncp[1] * ncp[2];
    const coeff = new Float64Array(nGrid);
    const rec = new Float32Array(nVox);
    const err = new Float32Array(nVox);

    // Approximating B-splines undershoot; iterate residuals so the reconstructed
    // field matches the observed log-bias instead of shrinking toward the mean.
    const innerIters = 5;
    for (let k = 0; k < innerIters; k++) {
        reconstructFromCoefficients(coeff, dims, ncp, support, rec);
        for (let i = 0; i < nVox; i++) {
            err[i] = mask[i] ? field[i] - rec[i] : 0;
        }
        const delta = splatToCoefficients(err, mask, dims, ncp, support);
        for (let i = 0; i < nGrid; i++) coeff[i] += delta[i];
    }

    reconstructFromCoefficients(coeff, dims, ncp, support, rec);
    return rec;
}

function sharpenResidualHistogram(
    residual: Float32Array,
    mask: Uint8Array,
    fwhm: number,
    wienerNoise: number
): Float32Array {
    const len = residual.length;
    const sharpened = new Float32Array(len);

    let rMin = Infinity;
    let rMax = -Infinity;
    for (let i = 0; i < len; i++) {
        if (!mask[i]) continue;
        const v = residual[i];
        if (v < rMin) rMin = v;
        if (v > rMax) rMax = v;
    }

    const range = rMax - rMin;
    if (!Number.isFinite(range) || range < 1e-8) {
        sharpened.set(residual);
        return sharpened;
    }

    const hist = new Float64Array(HIST_BINS);
    const binWidth = range / HIST_BINS;
    for (let i = 0; i < len; i++) {
        if (!mask[i]) continue;
        const b = Math.max(0, Math.min(HIST_BINS - 1, Math.floor((residual[i] - rMin) / binWidth)));
        hist[b] += 1;
    }

    const sigma = Math.max(1e-6, fwhm * FWHM_TO_SIGMA);
    const sigmaBins = sigma / binWidth;
    const deconv = wienerDeconvolveHistogram(hist, sigmaBins, wienerNoise);

    let pSum = 0;
    for (let i = 0; i < HIST_BINS; i++) pSum += deconv[i];
    if (pSum <= 0) {
        sharpened.set(residual);
        return sharpened;
    }
    for (let i = 0; i < HIST_BINS; i++) deconv[i] /= pSum;

    const centers = new Float64Array(HIST_BINS);
    for (let i = 0; i < HIST_BINS; i++) centers[i] = rMin + (i + 0.5) * binWidth;

    const mapping = new Float64Array(HIST_BINS);
    const invTwoSigma2 = 1 / (2 * sigma * sigma);
    for (let j = 0; j < HIST_BINS; j++) {
        const y = centers[j];
        let num = 0;
        let den = 0;
        for (let i = 0; i < HIST_BINS; i++) {
            const dx = y - centers[i];
            const g = Math.exp(-dx * dx * invTwoSigma2) * deconv[i];
            num += centers[i] * g;
            den += g;
        }
        mapping[j] = den > 1e-12 ? num / den : y;
    }

    for (let i = 0; i < len; i++) {
        if (!mask[i]) continue;
        const t = (residual[i] - rMin) / binWidth;
        const b0 = Math.max(0, Math.min(HIST_BINS - 1, Math.floor(t)));
        const b1 = Math.min(HIST_BINS - 1, b0 + 1);
        const f = t - b0;
        sharpened[i] = mapping[b0] * (1 - f) + mapping[b1] * f;
    }
    return sharpened;
}

function wienerDeconvolveHistogram(
    hist: Float64Array,
    sigmaBins: number,
    noise: number
): Float64Array {
    const n = hist.length;
    const kernel = new Float64Array(n);
    if (sigmaBins < 0.35) {
        return Float64Array.from(hist);
    }

    let ksum = 0;
    for (let i = 0; i < n; i++) {
        const d = i <= n / 2 ? i : i - n;
        const v = Math.exp(-0.5 * (d / sigmaBins) * (d / sigmaBins));
        kernel[i] = v;
        ksum += v;
    }
    for (let i = 0; i < n; i++) kernel[i] /= ksum;

    const H = dft(hist);
    const G = dft(kernel);
    const Fr = new Float64Array(n);
    const Fi = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        const mag2 = G.re[k] * G.re[k] + G.im[k] * G.im[k];
        const den = mag2 + noise;
        Fr[k] = (H.re[k] * G.re[k] + H.im[k] * G.im[k]) / den;
        Fi[k] = (H.im[k] * G.re[k] - H.re[k] * G.im[k]) / den;
    }

    const out = idft(Fr, Fi);
    for (let i = 0; i < n; i++) {
        if (out[i] < 0) out[i] = 0;
    }
    return out;
}

function dft(x: Float64Array): { re: Float64Array; im: Float64Array } {
    const n = x.length;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        let sr = 0;
        let si = 0;
        for (let t = 0; t < n; t++) {
            const a = (2 * Math.PI * k * t) / n;
            sr += x[t] * Math.cos(a);
            si -= x[t] * Math.sin(a);
        }
        re[k] = sr;
        im[k] = si;
    }
    return { re, im };
}

function idft(re: Float64Array, im: Float64Array): Float64Array {
    const n = re.length;
    const out = new Float64Array(n);
    for (let t = 0; t < n; t++) {
        let s = 0;
        for (let k = 0; k < n; k++) {
            const a = (2 * Math.PI * k * t) / n;
            s += re[k] * Math.cos(a) - im[k] * Math.sin(a);
        }
        out[t] = s / n;
    }
    return out;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}

async function report(onProgress: ((pct: number) => void | Promise<void>) | undefined, pct: number) {
    if (!onProgress) return;
    await onProgress(Math.max(0, Math.min(100, pct)));
}
