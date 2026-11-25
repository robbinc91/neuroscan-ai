import type { SegmentationStats, VolumeData } from '../types';
import { voxelSpacingMm } from './volumeMetadata';

export function computeSegmentationStats(
    volume: VolumeData,
    segmentation: VolumeData,
    labelMapping: Record<string, string> = {}
): SegmentationStats[] {
    const segData = segmentation.data;
    const volData = volume.data;
    const len = Math.min(segData.length, volData.length);

    const counts: Record<number, number> = {};
    const sums: Record<number, number> = {};
    const sqSums: Record<number, number> = {};

    for (let i = 0; i < len; i++) {
        const label = segData[i];
        if (label <= 0) continue;
        const val = volData[i];
        counts[label] = (counts[label] || 0) + 1;
        sums[label] = (sums[label] || 0) + val;
        sqSums[label] = (sqSums[label] || 0) + val * val;
    }

    const [spacingX, spacingY, spacingZ] = voxelSpacingMm(volume);
    const voxelVolMm3 = spacingX * spacingY * spacingZ;

    const computed: SegmentationStats[] = Object.keys(counts).map((key) => {
        const labelId = Number(key);
        const count = counts[labelId];
        const sum = sums[labelId];
        const sqSum = sqSums[labelId];
        const mean = sum / count;
        const variance = sqSum / count - mean * mean;
        const std = Math.sqrt(Math.max(0, variance));
        return {
            label: labelMapping[String(labelId)] || `Label ${labelId}`,
            volume: (count * voxelVolMm3) / 1000,
            intensityMean: mean,
            intensityStd: std
        };
    });

    computed.sort((a, b) => {
        const idA = parseInt(a.label.replace('Label ', ''), 10) || 0;
        const idB = parseInt(b.label.replace('Label ', ''), 10) || 0;
        return idA - idB;
    });

    return computed;
}
