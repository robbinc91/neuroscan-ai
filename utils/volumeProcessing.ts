import type { VolumeData } from '../types';
import { correctN4BiasField } from './n4BiasCorrection';
import { gaussianSmooth3D, medianFilter3D, localAdaptiveGaussianMask, claheVolume, tvDenoise3D } from './volumeFilters';

export type ProcessMethodId =
    | 'hist_eq'
    | 'clahe'
    | 'gamma_bright'
    | 'gamma_dark'
    | 'sigmoid'
    | 'gaussian'
    | 'unsharp'
    | 'hist_match'
    | 'n4_bias'
    | 'median_3d'
    | 'tv_denoise';

export type SegmentMethodId =
    | 'binary'
    | 'binary_inv'
    | 'truncate'
    | 'range_pass'
    | 'otsu'
    | 'li'
    | 'multi_otsu'
    | 'local_adaptive';

export interface VolumeProcessInput {
    method: string;
    data: ArrayLike<number>;
    dimensions: [number, number, number];
    min: number;
    max: number;
    param1: number;
    param2: number;
    affine?: number[];
    pixDims?: number[];
    geometryNotes?: string;
    refData?: ArrayLike<number>;
    refMin?: number;
    refMax?: number;
    onProgress?: (pct: number) => void | Promise<void>;
}

export interface VolumeProcessResult {
    data: Float32Array;
    min: number;
    max: number;
    geometryNotes?: string;
}

export interface VolumeSegmentInput {
    method: string;
    data: ArrayLike<number>;
    dimensions: [number, number, number];
    min: number;
    max: number;
    manualThreshold: number;
    manualUpper: number;
    localKernel: number;
    localOffset: number;
    affine?: number[];
    onProgress?: (pct: number) => void | Promise<void>;
}

export interface VolumeSegmentResult {
    data: Uint8Array;
    min: number;
    max: number;
    geometryNotes: string;
}

export async function processVolumeData(input: VolumeProcessInput): Promise<VolumeProcessResult> {
    const { method, data, dimensions, min, max, param1, param2, onProgress } = input;
    const [width, height, depth] = dimensions;
    const len = data.length;
    if (len !== width * height * depth) {
        throw new Error('Process: volume length does not match dimensions');
    }

    const range = max - min || 1;
    const report = makeReporter(onProgress);

    if (method === 'n4_bias') {
        const volume: VolumeData = {
            header: { pixDims: input.pixDims ?? [1, 1, 1, 1] },
            data: toFloat32(data),
            dimensions,
            min,
            max,
            affine: input.affine,
            geometryNotes: input.geometryNotes
        };
        const result = await correctN4BiasField(volume, {
            meshSpacingMm: param1,
            iterationsPerLevel: Math.max(1, Math.round(param2))
        }, onProgress);
        return {
            data: result.data,
            min: result.min,
            max: result.max,
            geometryNotes: input.geometryNotes
                ? `${input.geometryNotes};n4_bias_corrected`
                : 'n4_bias_corrected'
        };
    }

    if (method === 'gaussian') {
        const filtered = await gaussianSmooth3D(data, dimensions, param1, onProgress);
        return withMinMax(filtered);
    }

    if (method === 'median_3d') {
        const filtered = await medianFilter3D(data, dimensions, param1, onProgress);
        return withMinMax(filtered);
    }

    if (method === 'clahe') {
        const filtered = await claheVolume(data, dimensions, param1, param2, min, max, onProgress);
        return withMinMax(filtered);
    }

    if (method === 'unsharp') {
        const sigma = Math.max(0.3, param2 || 1);
        const blurred = await gaussianSmooth3D(data, dimensions, sigma, async (pct) => {
            await report(Math.floor(pct * 0.9));
        });
        const strength = param1;
        const outSharp = new Float32Array(len);
        const chunk = 500000;
        for (let i = 0; i < len; i += chunk) {
            const end = Math.min(i + chunk, len);
            for (let j = i; j < end; j++) {
                outSharp[j] = data[j] + strength * (data[j] - blurred[j]);
            }
        }
        await report(100);
        return withMinMax(outSharp);
    }

    if (method === 'tv_denoise') {
        const filtered = await tvDenoise3D(data, dimensions, param2, param1, onProgress);
        return withMinMax(filtered);
    }

    const out = new Float32Array(len);
    out.set(data as ArrayLike<number>);

    if (method === 'hist_eq') {
        const { histogram } = getHistogram(data, min, max);
        const cdf = new Int32Array(256);
        let sum = 0;
        for (let i = 0; i < 256; i++) { sum += histogram[i]; cdf[i] = sum; }
        const total = sum || 1;
        const chunk = 500000;
        for (let i = 0; i < len; i += chunk) {
            const end = Math.min(i + chunk, len);
            for (let j = i; j < end; j++) {
                const bin = Math.max(0, Math.min(255, Math.floor(((data[j] - min) / range) * 255)));
                out[j] = min + (cdf[bin] / total) * range;
            }
            await report(Math.floor((end / len) * 100));
        }
        return withMinMax(out);
    }

    if (method === 'gamma_bright' || method === 'gamma_dark') {
        const gamma = param1;
        const chunk = 500000;
        for (let i = 0; i < len; i += chunk) {
            const end = Math.min(i + chunk, len);
            for (let j = i; j < end; j++) {
                const norm = Math.max(0, (data[j] - min) / range);
                out[j] = min + Math.pow(norm, gamma) * range;
            }
            await report(Math.floor((end / len) * 100));
        }
        return withMinMax(out);
    }

    if (method === 'sigmoid') {
        const gain = param1;
        const cutoff = param2;
        const chunk = 500000;
        for (let i = 0; i < len; i += chunk) {
            const end = Math.min(i + chunk, len);
            for (let j = i; j < end; j++) {
                const u = (data[j] - min) / range;
                out[j] = min + (1 / (1 + Math.exp(-gain * (u - cutoff)))) * range;
            }
            await report(Math.floor((end / len) * 100));
        }
        return withMinMax(out);
    }

    if (method === 'hist_match') {
        if (!input.refData) throw new Error('Reference volume missing');
        const refMin = input.refMin ?? 0;
        const refMax = input.refMax ?? 1;
        const { histogram: hSrc } = getHistogram(data, min, max);
        const cdfSrc = new Float32Array(256);
        let sumSrc = 0;
        for (let i = 0; i < 256; i++) { sumSrc += hSrc[i]; cdfSrc[i] = sumSrc; }
        for (let i = 0; i < 256; i++) cdfSrc[i] /= sumSrc || 1;

        const { histogram: hRef } = getHistogram(input.refData, refMin, refMax);
        const cdfRef = new Float32Array(256);
        let sumRef = 0;
        for (let i = 0; i < 256; i++) { sumRef += hRef[i]; cdfRef[i] = sumRef; }
        for (let i = 0; i < 256; i++) cdfRef[i] /= sumRef || 1;

        const mapping = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
            const srcVal = cdfSrc[i];
            let closestIdx = 0, minDiff = 1;
            for (let j = 0; j < 256; j++) {
                const diff = Math.abs(cdfRef[j] - srcVal);
                if (diff < minDiff) { minDiff = diff; closestIdx = j; }
            }
            mapping[i] = closestIdx;
        }

        const refRange = refMax - refMin || 1;
        const chunk = 500000;
        for (let i = 0; i < len; i += chunk) {
            const end = Math.min(i + chunk, len);
            for (let j = i; j < end; j++) {
                const bin = Math.max(0, Math.min(255, Math.floor(((data[j] - min) / range) * 255)));
                out[j] = refMin + (mapping[bin] / 255) * refRange;
            }
            await report(Math.floor((end / len) * 100));
        }
        return withMinMax(out);
    }

    throw new Error(`Unknown processing method: ${method}`);
}

export async function segmentVolumeData(input: VolumeSegmentInput): Promise<VolumeSegmentResult> {
    const { method, data, dimensions, min, max, onProgress } = input;
    const len = data.length;
    if (len !== dimensions[0] * dimensions[1] * dimensions[2]) {
        throw new Error('Segment: volume length does not match dimensions');
    }
    const report = makeReporter(onProgress);

    if (method === 'local_adaptive') {
        const range = (max - min) || 1;
        const offset = (input.localOffset / 100) * range;
        const mask = await localAdaptiveGaussianMask(
            data, dimensions, input.localKernel, offset, min, max, onProgress
        );
        return { data: mask, min: 0, max: 1, geometryNotes: 'local_adaptive_gaussian' };
    }

    let threshold = input.manualThreshold;
    let upperThreshold = input.manualUpper;

    if (method === 'otsu' || method === 'li' || method === 'multi_otsu') {
        const { histogram, step } = getHistogram(data, min, max);
        let total = 0;
        for (let i = 0; i < 256; i++) total += histogram[i];
        if (method === 'otsu') {
            threshold = min + (computeOtsuThreshold(histogram, total) / step);
        } else if (method === 'li') {
            threshold = min + (computeLiThreshold(histogram, total) / step);
        } else {
            const t1Bin = computeOtsuThreshold(histogram, total);
            const hist2 = new Int32Array(256);
            let total2 = 0;
            for (let i = t1Bin; i < 256; i++) {
                hist2[i] = histogram[i];
                total2 += histogram[i];
            }
            const t2Bin = computeOtsuThreshold(hist2, total2);
            threshold = min + (t1Bin / step);
            upperThreshold = min + (Math.max(t1Bin + 1, t2Bin) / step);
        }
    }

    const mask = new Uint8Array(len);
    const chunk = 500000;
    for (let i = 0; i < len; i += chunk) {
        const end = Math.min(i + chunk, len);
        for (let j = i; j < end; j++) {
            const val = data[j];
            if (method === 'binary' || method === 'truncate') {
                if (val >= threshold) mask[j] = 1;
            } else if (method === 'binary_inv') {
                if (val <= threshold) mask[j] = 1;
            } else if (method === 'range_pass') {
                if (val >= threshold && val <= upperThreshold) mask[j] = 1;
            } else if (method === 'otsu' || method === 'li') {
                if (val >= threshold) mask[j] = 1;
            } else if (method === 'multi_otsu') {
                if (val >= threshold && val < upperThreshold) mask[j] = 1;
                else if (val >= upperThreshold) mask[j] = 2;
            }
        }
        await report(10 + Math.floor((end / len) * 80));
    }

    return {
        data: mask,
        min: 0,
        max: method === 'multi_otsu' ? 2 : 255,
        geometryNotes: 'local_threshold_segmentation'
    };
}

function getHistogram(data: ArrayLike<number>, min: number, max: number) {
    const histogram = new Int32Array(256);
    const range = max - min || 1;
    const step = 256 / range;
    const len = data.length;
    const stride = len > 2_000_000 ? Math.floor(len / 500_000) : 1;
    for (let i = 0; i < len; i += stride) {
        const bin = Math.floor((data[i] - min) * step);
        if (bin >= 0 && bin < 256) histogram[bin]++;
    }
    return { histogram, step };
}

function computeOtsuThreshold(histogram: Int32Array, total: number) {
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
        const varBetween = wB * wF * (mB - mF) * (mB - mF);
        if (varBetween > maxVar) {
            maxVar = varBetween;
            threshold = t;
        }
    }
    return threshold;
}

function computeLiThreshold(histogram: Int32Array, total: number) {
    let mean = 0;
    for (let i = 0; i < 256; i++) mean += i * histogram[i];
    mean /= total || 1;
    let threshold = Math.round(mean);
    for (let iter = 0; iter < 50; iter++) {
        let sumB = 0, wB = 0, sumF = 0, wF = 0;
        for (let i = 0; i <= threshold; i++) {
            wB += histogram[i];
            sumB += i * histogram[i];
        }
        for (let i = threshold + 1; i < 256; i++) {
            wF += histogram[i];
            sumF += i * histogram[i];
        }
        if (wB === 0 || wF === 0) break;
        const mB = sumB / wB;
        const mF = sumF / wF;
        if (mB <= 0 || mF <= 0) break;
        const next = Math.round((mF - mB) / (Math.log(mF) - Math.log(mB)));
        if (next === threshold) break;
        threshold = next;
    }
    return threshold;
}

function toFloat32(data: ArrayLike<number>): Float32Array {
    return data instanceof Float32Array ? data : Float32Array.from(data as ArrayLike<number>);
}

function withMinMax(data: Float32Array): VolumeProcessResult {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < data.length; i++) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (!Number.isFinite(min)) { min = 0; max = 0; }
    return { data, min, max };
}

function makeReporter(onProgress?: (pct: number) => void | Promise<void>) {
    return async (pct: number) => {
        if (!onProgress) return;
        await onProgress(Math.max(0, Math.min(100, pct)));
    };
}
