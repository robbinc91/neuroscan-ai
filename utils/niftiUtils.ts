import * as nifti from 'nifti-reader-js';
import { VolumeData, VolumeCoordSystem } from '../types';
import { flattenAffineFromNiftiMat } from './mat4';
import { metadataFromNifti } from './volumeMetadata';

type NiftiNumericArray = Float32Array | Int16Array | Uint8Array | Int32Array | Float64Array | Uint16Array;

function isGzipBuffer(data: ArrayBuffer): boolean {
    if (data.byteLength < 2) return false;
    const b = new Uint8Array(data);
    return b[0] === 0x1f && b[1] === 0x8b;
}

/** Chromium native gzip — much faster than nifti-reader-js / fflate on first .nii.gz load. */
async function gunzipNative(data: ArrayBuffer): Promise<ArrayBuffer> {
    if (typeof DecompressionStream === 'undefined') {
        return nifti.decompress(data);
    }
    try {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
        return await new Response(stream).arrayBuffer();
    } catch {
        return nifti.decompress(data);
    }
}

function applyNiftiIntensityScale(
    header: { scl_slope?: number; scl_inter?: number },
    typedData: NiftiNumericArray
): { data: NiftiNumericArray; min: number; max: number; scaled: boolean } {
    const slope = header.scl_slope;
    const intercept = header.scl_inter ?? 0;
    // NIfTI: scl_slope of 0 means "do not scale".
    const scaled =
        Number.isFinite(slope) &&
        slope !== 0 &&
        (slope !== 1 || intercept !== 0);

    let min = Infinity;
    let max = -Infinity;
    if (scaled) {
        const out = new Float32Array(typedData.length);
        const s = slope as number;
        for (let i = 0; i < typedData.length; i++) {
            const val = typedData[i] * s + intercept;
            out[i] = val;
            if (Number.isFinite(val)) {
                if (val < min) min = val;
                if (val > max) max = val;
            }
        }
        if (!Number.isFinite(min) || !Number.isFinite(max)) {
            min = 0;
            max = 1;
        }
        return { data: out, min, max, scaled: true };
    }

    for (let i = 0; i < typedData.length; i++) {
        const val = typedData[i];
        if (!Number.isFinite(val)) continue;
        if (val < min) min = val;
        if (val > max) max = val;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        min = 0;
        max = 1;
    }
    return { data: typedData, min, max, scaled: false };
}

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

function parseNiftiUncompressed(data: ArrayBuffer): VolumeData | null {
    if (!nifti.isNIFTI(data)) {
        console.error('Not a valid NIfTI file');
        return null;
    }

    const header = nifti.readHeader(data);
    if (!header) return null;
    const image = nifti.readImage(header, data);

    let typedData: NiftiNumericArray;

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

    const { data: scaledData, min, max, scaled } = applyNiftiIntensityScale(header, typedData);

    const affine = flattenAffineFromNiftiMat(header.affine);
    const coordSystem = coordSystemFromNiftiHeader(header);
    const geomNoteParts = [
        header.qform_code > 0 || header.sform_code > 0
            ? `nifti:qform=${header.qform_code};sform=${header.sform_code}`
            : 'nifti:affine_fallback_pixdim_only'
    ];
    if (scaled) {
        geomNoteParts.push(`scl_slope=${header.scl_slope};scl_inter=${header.scl_inter}`);
    }
    const geomNote = geomNoteParts.join(';');

    const volume: VolumeData = {
        header,
        data: scaledData,
        dimensions: [header.dims[1], header.dims[2], header.dims[3]],
        min,
        max,
        affine,
        coordSystem,
        geometryNotes: geomNote
    };
    volume.metadata = metadataFromNifti(volume);
    return volume;
}

export const parseNiftiFile = (arrayBuffer: ArrayBuffer): VolumeData | null => {
    let data = arrayBuffer;
    if (nifti.isCompressed(data) || isGzipBuffer(data)) {
        data = nifti.decompress(data);
    }
    return parseNiftiUncompressed(data);
};

/** Same as parseNiftiFile, but gzip uses the browser's native decompressor and yields to the UI. */
export async function parseNiftiFileAsync(arrayBuffer: ArrayBuffer): Promise<VolumeData | null> {
    let data = arrayBuffer;
    if (nifti.isCompressed(data) || isGzipBuffer(data)) {
        data = await gunzipNative(data);
    }
    return parseNiftiUncompressed(data);
}

/** Prime gzip + NIfTI code paths so the first real load is not a cold JIT. */
export async function warmupNiftiParser(): Promise<void> {
    try {
        nifti.isCompressed(new Uint8Array([0, 0]).buffer);
        if (typeof DecompressionStream !== 'undefined') {
            void new DecompressionStream('gzip');
        }
        const emptyGz = Uint8Array.from([
            0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff,
            0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
        ]);
        await gunzipNative(emptyGz.buffer);
    } catch {
        /* warmup only */
    }
}
