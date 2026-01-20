
import { VolumeData } from '../types';

export const computeVolumeDifference = (volA: VolumeData, volB: VolumeData): VolumeData | null => {
    // Basic validation: dimensions must match
    if (volA.data.length !== volB.data.length) {
        console.warn("Volumes have different sizes, cannot compute difference.");
        return null;
    }

    const len = volA.data.length;
    const diffData = new Float32Array(len);
    let min = Infinity;
    let max = -Infinity;

    // Simple subtraction: B - A (Change from A to B)
    for(let i=0; i<len; i++) {
        // Normalize roughly if needed, but assuming registered same-scale MRI
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
        max
    };
};

export const computeSegmentationDifference = (segA: VolumeData | null, segB: VolumeData | null, dimRef: [number, number, number]): VolumeData | null => {
    if (!segA && !segB) return null;

    const len = segA ? segA.data.length : (segB ? segB.data.length : 0);
    if (len === 0) return null;

    // Output codes:
    // 0: Background / No Change (if 0 in both)
    // 1: Disappeared (In A, not in B) -> Red
    // 2: New (In B, not in A) -> Green
    // 3: Stable (In both) -> Blue/Gray
    
    const diffData = new Uint8Array(len);
    
    const dataA = segA ? segA.data : new Uint8Array(len);
    const dataB = segB ? segB.data : new Uint8Array(len);

    for(let i=0; i<len; i++) {
        const valA = dataA[i] > 0;
        const valB = dataB[i] > 0;

        if (valA && !valB) diffData[i] = 1;      // Removed
        else if (!valA && valB) diffData[i] = 2; // New
        else if (valA && valB) diffData[i] = 3;  // Stable
        else diffData[i] = 0;
    }

    return {
        header: { dims: [3, dimRef[0], dimRef[1], dimRef[2], 1, 1, 1, 1], datatypeCode: 2 },
        dimensions: [...dimRef],
        data: diffData,
        min: 0,
        max: 3
    };
};
