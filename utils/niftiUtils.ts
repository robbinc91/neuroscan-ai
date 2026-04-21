import * as nifti from 'nifti-reader-js';
import { VolumeData, VolumeCoordSystem } from '../types';
import { flattenAffineFromNiftiMat } from './mat4';

function coordSystemFromNiftiHeader(header: { qform_code?: number; sform_code?: number }): VolumeCoordSystem {
    const q = header.qform_code ?? 0;
    const s = header.sform_code ?? 0;
    const code = Math.max(q, s);
    const N1 = nifti.NIFTI1;
    if (code === N1.XFORM_MNI_152) return 'MNI_152';
    if (code === N1.XFORM_SCANNER_ANAT || code === N1.XFORM_ALIGNED_ANAT) return 'SCANNER_ANAT';
    if (code === N1.XFORM_TALAIRACH) return 'UNKNOWN';
    if (code > 0) return 'RAS';
    return 'UNKNOWN';
}

export const parseNiftiFile = (arrayBuffer: ArrayBuffer): VolumeData | null => {
    let data = arrayBuffer;

    if (nifti.isCompressed(data)) {
        data = nifti.decompress(data);
    }

    if (!nifti.isNIFTI(data)) {
        console.error('Not a valid NIfTI file');
        return null;
    }

    const header = nifti.readHeader(data);
    const image = nifti.readImage(header, data);

    let typedData: Float32Array | Int16Array | Uint8Array | Int32Array | Float64Array | Uint16Array;

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
            console.warn('Unsupported datatype code:', header.datatypeCode, 'Falling back to Uint8');
            typedData = new Uint8Array(image);
    }

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < typedData.length; i += 10) {
        const val = typedData[i];
        if (val < min) min = val;
        if (val > max) max = val;
    }

    const affine = flattenAffineFromNiftiMat(header.affine);
    const coordSystem = coordSystemFromNiftiHeader(header);
    const geomNote =
        header.qform_code > 0 || header.sform_code > 0
            ? `nifti:qform=${header.qform_code};sform=${header.sform_code}`
            : 'nifti:affine_fallback_pixdim_only';

    return {
        header,
        data: typedData,
        dimensions: [header.dims[1], header.dims[2], header.dims[3]],
        min,
        max,
        affine,
        coordSystem,
        geometryNotes: geomNote
    };
};
