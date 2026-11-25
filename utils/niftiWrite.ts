import type { VolumeData } from '../types';
import { voxelSpacingMm } from './volumeMetadata';

const NIFTI1_HEADER = 348;
const NIFTI1_VOX_OFFSET = 352;
const DT_UINT8 = 2;
const DT_FLOAT32 = 16;

async function gzipCompress(raw: Uint8Array): Promise<ArrayBuffer> {
    if (typeof CompressionStream === 'undefined') {
        throw new Error('Gzip compression is not available in this runtime.');
    }
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
    return await new Response(stream).arrayBuffer();
}

function writeMagic(view: DataView, offset: number) {
    view.setUint8(offset, 110); // n
    view.setUint8(offset + 1, 43); // +
    view.setUint8(offset + 2, 49); // 1
    view.setUint8(offset + 3, 0);
}

function voxelBytes(volume: VolumeData, asMask: boolean): { datatype: number; bitpix: number; body: Uint8Array } {
    const n = volume.dimensions[0] * volume.dimensions[1] * volume.dimensions[2];
    if (asMask || volume.data instanceof Uint8Array) {
        const body = new Uint8Array(n);
        const src = volume.data;
        const len = Math.min(n, src.length);
        for (let i = 0; i < len; i++) body[i] = src[i] & 255;
        return { datatype: DT_UINT8, bitpix: 8, body };
    }
    const body = new Uint8Array(n * 4);
    const view = new DataView(body.buffer);
    const src = volume.data;
    const len = Math.min(n, src.length);
    for (let i = 0; i < len; i++) view.setFloat32(i * 4, src[i], true);
    return { datatype: DT_FLOAT32, bitpix: 32, body };
}

/** Encode a volume as gzip-compressed NIfTI-1 (.nii.gz). */
export async function encodeNiftiGz(volume: VolumeData, options?: { mask?: boolean }): Promise<ArrayBuffer> {
    const [nx, ny, nz] = volume.dimensions;
    const asMask = !!options?.mask;
    const { datatype, bitpix, body } = voxelBytes(volume, asMask);
    const header = new ArrayBuffer(NIFTI1_VOX_OFFSET);
    const view = new DataView(header);
    const little = true;

    view.setInt32(0, NIFTI1_HEADER, little);
    view.setInt16(40, 3, little);
    view.setInt16(42, nx, little);
    view.setInt16(44, ny, little);
    view.setInt16(46, nz, little);
    view.setInt16(48, 1, little);
    view.setInt16(70, datatype, little);
    view.setInt16(72, bitpix, little);

    const [sx, sy, sz] = voxelSpacingMm(volume);
    view.setFloat32(76, 1, little);
    view.setFloat32(80, sx, little);
    view.setFloat32(84, sy, little);
    view.setFloat32(88, sz, little);
    view.setFloat32(108, NIFTI1_VOX_OFFSET, little);
    view.setFloat32(112, 1, little);
    view.setFloat32(116, 0, little);
    view.setUint8(123, 2);
    view.setFloat32(124, volume.max, little);
    view.setFloat32(128, volume.min, little);

    const affine = volume.affine;
    if (affine && affine.length >= 16) {
        view.setInt16(254, 1, little);
        for (let i = 0; i < 12; i++) {
            view.setFloat32(280 + i * 4, affine[i], little);
        }
    }

    writeMagic(view, 344);

    const out = new Uint8Array(NIFTI1_VOX_OFFSET + body.byteLength);
    out.set(new Uint8Array(header), 0);
    out.set(body, NIFTI1_VOX_OFFSET);
    return gzipCompress(out);
}
