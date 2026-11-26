import type { VolumeData } from '../types';
import { voxelSpacingMm } from './volumeMetadata';

export interface LabelChangeRow {
    labelId: number;
    label: string;
    volACm3: number;
    volBCm3: number;
    deltaCm3: number;
    pctChange: number | null;
    dice: number | null;
}

export interface ComparisonMetrics {
    overallDice: number | null;
    rows: LabelChangeRow[];
    note: string;
}

function labelName(id: number, mapping: Record<string, string>): string {
    return mapping[String(id)] || `Label ${id}`;
}

/** Dice and per-label volume change. Masks must already share the reference grid. */
export function computeDiceAndVolumeChange(
    segA: VolumeData | null,
    segB: VolumeData | null,
    refVolume: VolumeData,
    labelMapping: Record<string, string> = {}
): ComparisonMetrics | null {
    if (!segA && !segB) {
        return {
            overallDice: null,
            rows: [],
            note: 'Load a mask on both studies for Dice and volume change.'
        };
    }

    const [sx, sy, sz] = voxelSpacingMm(refVolume);
    const voxelCm3 = (sx * sy * sz) / 1000;
    const len = refVolume.data.length;
    const a = segA && segA.data.length === len ? segA.data : null;
    const b = segB && segB.data.length === len ? segB.data : null;

    if (!a && !b) {
        return {
            overallDice: null,
            rows: [],
            note: 'Segmentations are not on the baseline grid, so overlap could not be measured.'
        };
    }

    const ids = new Set<number>();
    let interBin = 0;
    let unionA = 0;
    let unionB = 0;
    const countA: Record<number, number> = {};
    const countB: Record<number, number> = {};
    const inter: Record<number, number> = {};

    for (let i = 0; i < len; i++) {
        const va = a ? a[i] : 0;
        const vb = b ? b[i] : 0;
        if (va > 0) {
            unionA++;
            countA[va] = (countA[va] || 0) + 1;
            ids.add(va);
        }
        if (vb > 0) {
            unionB++;
            countB[vb] = (countB[vb] || 0) + 1;
            ids.add(vb);
        }
        if (va > 0 && vb > 0) interBin++;
        if (va > 0 && va === vb) inter[va] = (inter[va] || 0) + 1;
    }

    const overallDice = unionA + unionB > 0 ? (2 * interBin) / (unionA + unionB) : null;
    const rows: LabelChangeRow[] = [...ids]
        .sort((x, y) => x - y)
        .map((id) => {
            const nA = countA[id] || 0;
            const nB = countB[id] || 0;
            const nI = inter[id] || 0;
            const volA = nA * voxelCm3;
            const volB = nB * voxelCm3;
            return {
                labelId: id,
                label: labelName(id, labelMapping),
                volACm3: volA,
                volBCm3: volB,
                deltaCm3: volB - volA,
                pctChange: nA > 0 ? ((nB - nA) / nA) * 100 : null,
                dice: nA + nB > 0 ? (2 * nI) / (nA + nB) : null
            };
        });

    const note = !a || !b
        ? 'Dice needs a mask on both baseline and follow-up. Volumes are shown for the available mask.'
        : 'Dice is 2|A∩B|/(|A|+|B|) on the baseline grid. Follow-up was resampled when geometry differed.';

    return { overallDice, rows, note };
}
