
import { VolumeData } from '../types';
import { maxAbsDiffMat4 } from './mat4';
import { resampleDiscreteVolumeOntoReference, resampleScalarVolumeOntoReference } from './resampleVolume';

const AFFINE_EQ_TOL_MM = 0.05;

export const computeVolumeDifference = (volA: VolumeData, volB: VolumeData): VolumeData | null => {
    if (volA.data.length !== volB.data.length) {
        console.warn('Volumes have different sizes, cannot compute difference.');
        return null;
    }

    const len = volA.data.length;
    const diffData = new Float32Array(len);
    let min = Infinity;
    let max = -Infinity;

    for (let i = 0; i < len; i++) {
        const val = volB.data[i] - volA.data[i];
        diffData[i] = val;
        if (val < min) min = val;
        if (val > max) max = val;
    }

    return {
        header: { ...volA.header, datatypeCode: 16 },
        dimensions: [...volA.dimensions],
        data: diffData,
        min,
        max,
        affine: volA.affine ? [...volA.affine] : undefined,
        coordSystem: volA.coordSystem,
        geometryNotes: `difference_followup_minus_baseline;${volA.geometryNotes || ''}`
    };
};

/**
 * Aligns follow-up onto baseline voxel grid when affines differ (trilinear).
 * Falls back to same-grid subtraction when geometry matches or resampling is unavailable.
 */
export const computeVolumeDifferenceWithGeometry = (volA: VolumeData, volB: VolumeData): VolumeData | null => {
    let bAdj = volB;
    const sizeMatch =
        volA.dimensions[0] === volB.dimensions[0] &&
        volA.dimensions[1] === volB.dimensions[1] &&
        volA.dimensions[2] === volB.dimensions[2];

    if (volA.affine && volB.affine) {
        const affineMatch = sizeMatch && maxAbsDiffMat4(volA.affine, volB.affine) < AFFINE_EQ_TOL_MM;
        if (!affineMatch) {
            const res = resampleScalarVolumeOntoReference(volB, volA);
            if (res) bAdj = res;
            else if (!sizeMatch) {
                console.warn('Volume difference: could not resample onto baseline (singular affine or missing metadata).');
                return null;
            }
        }
    } else if (!sizeMatch) {
        console.warn('Volume difference: grid size mismatch without affines on both volumes.');
        return null;
    }

    return computeVolumeDifference(volA, bAdj);
};

/** Resample segmentation mask onto reference volume when grids or affines differ. */
export const alignSegmentationToReferenceVolume = (
    seg: VolumeData | null,
    refVolume: VolumeData
): VolumeData | null => {
    if (!seg) return null;
    const sameSize =
        seg.dimensions[0] === refVolume.dimensions[0] &&
        seg.dimensions[1] === refVolume.dimensions[1] &&
        seg.dimensions[2] === refVolume.dimensions[2];
    if (sameSize && seg.affine && refVolume.affine && maxAbsDiffMat4(seg.affine, refVolume.affine) < AFFINE_EQ_TOL_MM) {
        return seg;
    }
    if (!seg.affine || !refVolume.affine) {
        return sameSize ? seg : null;
    }
    const res = resampleDiscreteVolumeOntoReference(seg, refVolume);
    return res ?? (sameSize ? seg : null);
};

export const computeSegmentationDifference = (
    segA: VolumeData | null,
    segB: VolumeData | null,
    refVolume: VolumeData
): VolumeData | null => {
    if (!segA && !segB) return null;

    const len = segA ? segA.data.length : segB ? segB.data.length : 0;
    if (len === 0) return null;

    const diffData = new Uint8Array(len);

    const dataA = segA ? segA.data : new Uint8Array(len);
    const dataB = segB ? segB.data : new Uint8Array(len);

    for (let i = 0; i < len; i++) {
        const valA = dataA[i] > 0;
        const valB = dataB[i] > 0;

        if (valA && !valB) diffData[i] = 1;
        else if (!valA && valB) diffData[i] = 2;
        else if (valA && valB) diffData[i] = 3;
        else diffData[i] = 0;
    }

    const dimRef = refVolume.dimensions;

    return {
        header: { dims: [3, dimRef[0], dimRef[1], dimRef[2], 1, 1, 1, 1], datatypeCode: 2 },
        dimensions: [...dimRef],
        data: diffData,
        min: 0,
        max: 3,
        affine: refVolume.affine ? [...refVolume.affine] : undefined,
        coordSystem: refVolume.coordSystem,
        geometryNotes: 'segmentation_change_map'
    };
};
