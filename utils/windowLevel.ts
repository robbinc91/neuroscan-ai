import type { VolumeData, WindowLevel } from '../types';

export type WlPresetId = 'auto' | 't1' | 't2' | 'flair' | 'ct-brain' | 'ct-bone' | 'full';

export interface WlPreset {
    id: WlPresetId;
    label: string;
    kind: 'percentile' | 'absolute' | 'full';
    lo?: number;
    hi?: number;
    width?: number;
    center?: number;
}

export const WL_PRESETS: WlPreset[] = [
    { id: 'auto', label: 'Auto', kind: 'percentile', lo: 0.5, hi: 99.5 },
    { id: 't1', label: 'T1', kind: 'percentile', lo: 2, hi: 96 },
    { id: 't2', label: 'T2', kind: 'percentile', lo: 1, hi: 98 },
    { id: 'flair', label: 'FLAIR', kind: 'percentile', lo: 5, hi: 94 },
    { id: 'ct-brain', label: 'CT Brain', kind: 'absolute', width: 80, center: 40 },
    { id: 'ct-bone', label: 'CT Bone', kind: 'absolute', width: 2500, center: 480 },
    { id: 'full', label: 'Full', kind: 'full' }
];

export function windowBounds(wl: WindowLevel): { lo: number; hi: number } {
    const half = Math.max(1e-6, wl.width) / 2;
    return { lo: wl.center - half, hi: wl.center + half };
}

export function formatWindowLevel(wl: WindowLevel): string {
    const w = wl.width >= 100 ? wl.width.toFixed(0) : wl.width.toFixed(1);
    const c = Math.abs(wl.center) >= 100 ? wl.center.toFixed(0) : wl.center.toFixed(1);
    return `W ${w}  L ${c}`;
}

export function defaultWindowLevel(min: number, max: number): WindowLevel {
    const width = Math.max(1e-3, max - min);
    return { width, center: (min + max) / 2 };
}

export function applyWlPreset(volume: VolumeData, preset: WlPreset): WindowLevel {
    if (preset.kind === 'absolute') {
        return {
            width: Math.max(1e-3, preset.width ?? 80),
            center: preset.center ?? 40
        };
    }
    if (preset.kind === 'full') {
        return defaultWindowLevel(volume.min, volume.max);
    }
    const lo = intensityPercentile(volume, preset.lo ?? 0.5);
    const hi = intensityPercentile(volume, preset.hi ?? 99.5);
    const width = Math.max(1e-3, hi - lo);
    return { width, center: lo + width / 2 };
}

export function intensityPercentile(volume: VolumeData, percentile: number): number {
    const { data, min, max } = volume;
    const range = max - min || 1;
    const hist = new Float64Array(256);
    const len = data.length;
    const stride = len > 2_000_000 ? Math.floor(len / 400_000) : 1;
    let total = 0;
    for (let i = 0; i < len; i += stride) {
        const v = data[i];
        if (!Number.isFinite(v)) continue;
        const bin = Math.max(0, Math.min(255, Math.floor(((v - min) / range) * 255)));
        hist[bin]++;
        total++;
    }
    if (total < 1) return min;
    const target = Math.max(0, Math.min(1, percentile / 100)) * total;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
        acc += hist[i];
        if (acc >= target) return min + ((i + 0.5) / 255) * range;
    }
    return max;
}

export function autoWindowLevel(volume: VolumeData): WindowLevel {
    return applyWlPreset(volume, WL_PRESETS[0]);
}
