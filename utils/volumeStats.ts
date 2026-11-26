import type { VolumeData } from '../types';
import { voxelSpacingMm } from './volumeMetadata';

export interface HistogramBin {
    x: number;
    count: number;
}

export interface VolumeIntensityStats {
    voxelCount: number;
    foregroundCount: number;
    volumeCm3: number;
    foregroundCm3: number;
    min: number;
    max: number;
    mean: number;
    std: number;
    p5: number;
    p50: number;
    p95: number;
    histogram: HistogramBin[];
}

export interface TissueContrast {
    wmLabel?: number;
    gmLabel?: number;
    wmMean?: number;
    gmMean?: number;
    noiseStd?: number;
    snrWm?: number;
    snrGm?: number;
    cnr?: number;
    note: string;
}

const HIST_BINS = 64;

function percentileFromHist(counts: Int32Array, edges: number[], total: number, q: number): number {
    const target = Math.max(0, Math.min(total - 1, Math.floor(q * (total - 1))));
    let acc = 0;
    for (let i = 0; i < counts.length; i++) {
        acc += counts[i];
        if (acc > target) {
            const lo = edges[i];
            const hi = edges[i + 1];
            return lo + (hi - lo) * 0.5;
        }
    }
    return edges[edges.length - 1];
}

/** Whole-volume intensity stats and a display histogram. Foreground is voxels above the 2nd percentile. */
export function computeVolumeIntensityStats(volume: VolumeData): VolumeIntensityStats {
    const data = volume.data;
    const n = data.length;
    const min = volume.min;
    const max = volume.max;
    const range = Math.max(1e-6, max - min);
    const counts = new Int32Array(HIST_BINS);
    const edges = new Array<number>(HIST_BINS + 1);
    for (let i = 0; i <= HIST_BINS; i++) edges[i] = min + (range * i) / HIST_BINS;

    let sum = 0;
    let sq = 0;
    for (let i = 0; i < n; i++) {
        const v = data[i];
        sum += v;
        sq += v * v;
        let bin = Math.floor(((v - min) / range) * HIST_BINS);
        if (bin < 0) bin = 0;
        if (bin >= HIST_BINS) bin = HIST_BINS - 1;
        counts[bin]++;
    }

    const mean = n > 0 ? sum / n : 0;
    const std = n > 0 ? Math.sqrt(Math.max(0, sq / n - mean * mean)) : 0;
    const p5 = percentileFromHist(counts, edges, n, 0.05);
    const p50 = percentileFromHist(counts, edges, n, 0.5);
    const p95 = percentileFromHist(counts, edges, n, 0.95);
    const p2 = percentileFromHist(counts, edges, n, 0.02);

    let foregroundCount = 0;
    for (let i = 0; i < n; i++) if (data[i] > p2) foregroundCount++;

    const [sx, sy, sz] = voxelSpacingMm(volume);
    const voxelCm3 = (sx * sy * sz) / 1000;
    const histogram: HistogramBin[] = [];
    for (let i = 0; i < HIST_BINS; i++) {
        histogram.push({ x: (edges[i] + edges[i + 1]) / 2, count: counts[i] });
    }

    return {
        voxelCount: n,
        foregroundCount,
        volumeCm3: n * voxelCm3,
        foregroundCm3: foregroundCount * voxelCm3,
        min,
        max,
        mean,
        std,
        p5,
        p50,
        p95,
        histogram
    };
}

function tissueKind(name: string): 'wm' | 'gm' | 'csf' | null {
    const n = name.toLowerCase().replace(/[_-]+/g, ' ').trim();
    if (/\b(wm|white matter)\b/.test(n) || n === 'white') return 'wm';
    if (/\b(gm|grey matter|gray matter)\b/.test(n) || n === 'gray' || n === 'grey') return 'gm';
    if (/\b(csf|cerebrospinal)\b/.test(n)) return 'csf';
    return null;
}

function uniquePositiveLabels(seg: VolumeData): number[] {
    const seen = new Set<number>();
    const data = seg.data;
    const len = data.length;
    for (let i = 0; i < len; i++) {
        const v = data[i];
        if (v > 0) seen.add(v);
    }
    return [...seen].sort((a, b) => a - b);
}

function meanOfLabel(volume: VolumeData, seg: VolumeData, label: number): number | undefined {
    const v = volume.data;
    const s = seg.data;
    const len = Math.min(v.length, s.length);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < len; i++) {
        if (s[i] === label) {
            sum += v[i];
            n++;
        }
    }
    return n > 0 ? sum / n : undefined;
}

function backgroundStd(volume: VolumeData, stats: VolumeIntensityStats): number | undefined {
    if (stats.voxelCount === 0) return undefined;
    const fgFrac = stats.foregroundCount / stats.voxelCount;
    if (fgFrac > 0.9) return undefined;
    const data = volume.data;
    const cap = stats.p5;
    let sum = 0;
    let sq = 0;
    let n = 0;
    for (let i = 0; i < data.length; i++) {
        const val = data[i];
        if (val <= cap) {
            sum += val;
            sq += val * val;
            n++;
        }
    }
    if (n < 100) return undefined;
    const mean = sum / n;
    return Math.sqrt(Math.max(0, sq / n - mean * mean));
}

/**
 * SNR = mean(tissue) / std(background below p5).
 * CNR = |mean(WM) − mean(GM)| / std(background).
 * Uses label-map names, or FAST 2=GM / 3=WM when those labels exist and no map names match.
 */
export function computeTissueContrast(
    volume: VolumeData,
    segmentation: VolumeData | null,
    stats: VolumeIntensityStats,
    labelMapping: Record<string, string> = {}
): TissueContrast | null {
    if (!segmentation) return null;

    let wm: number | undefined;
    let gm: number | undefined;
    let fromMap = false;

    for (const [key, name] of Object.entries(labelMapping)) {
        const id = Number(key);
        if (!Number.isFinite(id)) continue;
        const kind = tissueKind(String(name));
        if (kind === 'wm') {
            wm = id;
            fromMap = true;
        }
        if (kind === 'gm') {
            gm = id;
            fromMap = true;
        }
    }

    const labels = uniquePositiveLabels(segmentation);
    if (!fromMap && labels.includes(2) && labels.includes(3)) {
        gm = 2;
        wm = 3;
    }

    if (wm == null && gm == null) return null;

    const noiseStd = backgroundStd(volume, stats);
    const wmMean = wm != null ? meanOfLabel(volume, segmentation, wm) : undefined;
    const gmMean = gm != null ? meanOfLabel(volume, segmentation, gm) : undefined;

    const snrWm = wmMean != null && noiseStd && noiseStd > 1e-8 ? wmMean / noiseStd : undefined;
    const snrGm = gmMean != null && noiseStd && noiseStd > 1e-8 ? gmMean / noiseStd : undefined;
    const cnr =
        wmMean != null && gmMean != null && noiseStd && noiseStd > 1e-8
            ? Math.abs(wmMean - gmMean) / noiseStd
            : undefined;

    const assumed = !fromMap && wm === 3 && gm === 2;
    const note = !noiseStd
        ? 'Not enough background (air) voxels to estimate noise — SNR/CNR omitted.'
        : assumed
            ? 'FAST labels assumed (2 = GM, 3 = WM). Map names override this.'
            : 'WM/GM identified from the label map. Noise = SD of voxels ≤ 5th percentile.';

    return { wmLabel: wm, gmLabel: gm, wmMean, gmMean, noiseStd, snrWm, snrGm, cnr, note };
}
