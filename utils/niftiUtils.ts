import * as nifti from 'nifti-reader-js';
import { VolumeData } from '../types';

export const parseNiftiFile = (arrayBuffer: ArrayBuffer): VolumeData | null => {
    let data = arrayBuffer;
    
    // Check for GZIP compression
    if (nifti.isCompressed(data)) {
        data = nifti.decompress(data);
    }

    if (!nifti.isNIFTI(data)) {
        console.error("Not a valid NIfTI file");
        return null;
    }

    const header = nifti.readHeader(data);
    const image = nifti.readImage(header, data);
    
    // Determine TypedArray based on datatypeCode
    let typedData: Float32Array | Int16Array | Uint8Array | Int32Array | Float64Array | Uint16Array;
    
    // Common NIfTI Datatype Codes:
    // 2: UINT8, 4: INT16, 8: INT32, 16: FLOAT32, 64: FLOAT64
    switch (header.datatypeCode) {
        case 2:
            typedData = new Uint8Array(image);
            break;
        case 4:
            typedData = new Int16Array(image);
            break;
        case 8:
            typedData = new Int32Array(image);
            break;
        case 16:
            typedData = new Float32Array(image);
            break;
        case 64:
            typedData = new Float64Array(image);
            break;
        case 512:
            typedData = new Uint16Array(image);
            break;
        default:
            console.warn("Unsupported datatype code:", header.datatypeCode, "Falling back to Uint8");
            typedData = new Uint8Array(image);
    }

    // Basic min/max calculation for default windowing
    let min = Infinity;
    let max = -Infinity;
    // Sample a subset for speed if large volume, or all
    for (let i = 0; i < typedData.length; i+=10) { 
        const val = typedData[i];
        if (val < min) min = val;
        if (val > max) max = val;
    }

    return {
        header,
        data: typedData,
        dimensions: [header.dims[1], header.dims[2], header.dims[3]], // Nifti dims are [dim, x, y, z, t, ...]
        min,
        max
    };
}