import type { VolumeData } from '../types';
import { invertMat4RowMajor, voxelCenterToPatientRowMajor } from './mat4';

function applyMat4Point(m: number[], x: number, y: number, z: number): [number, number, number, number] {
    return [
        m[0] * x + m[1] * y + m[2] * z + m[3],
        m[4] * x + m[5] * y + m[6] * z + m[7],
        m[8] * x + m[9] * y + m[10] * z + m[11],
        m[12] * x + m[13] * y + m[14] * z + m[15]
    ];
}

export function readVoxel(
    data: Float32Array | Int16Array | Uint8Array | Int32Array | Float64Array | Uint16Array,
    nx: number,
    ny: number,
    nz: number,
    ix: number,
    iy: number,
    iz: number
): number {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return 0;
    return data[ix + iy * nx + iz * nx * ny];
}

export function sampleTrilinear(
    data: Float32Array | Int16Array | Uint8Array | Int32Array | Float64Array | Uint16Array,
    nx: number,
    ny: number,
    nz: number,
    fx: number,
    fy: number,
    fz: number
): number {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const z0 = Math.floor(fz);
    const x1 = Math.min(nx - 1, x0 + 1);
    const y1 = Math.min(ny - 1, y0 + 1);
    const z1 = Math.min(nz - 1, z0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const tz = fz - z0;

    const c000 = readVoxel(data, nx, ny, nz, x0, y0, z0);
    const c100 = readVoxel(data, nx, ny, nz, x1, y0, z0);
    const c010 = readVoxel(data, nx, ny, nz, x0, y1, z0);
    const c110 = readVoxel(data, nx, ny, nz, x1, y1, z0);
    const c001 = readVoxel(data, nx, ny, nz, x0, y0, z1);
    const c101 = readVoxel(data, nx, ny, nz, x1, y0, z1);
    const c011 = readVoxel(data, nx, ny, nz, x0, y1, z1);
    const c111 = readVoxel(data, nx, ny, nz, x1, y1, z1);

    const c00 = c000 * (1 - tx) + c100 * tx;
    const c10 = c010 * (1 - tx) + c110 * tx;
    const c01 = c001 * (1 - tx) + c101 * tx;
    const c11 = c011 * (1 - tx) + c111 * tx;
    const c0 = c00 * (1 - ty) + c10 * ty;
    const c1 = c01 * (1 - ty) + c11 * ty;
    return c0 * (1 - tz) + c1 * tz;
}

export function sampleNearest(
    data: Float32Array | Int16Array | Uint8Array | Int32Array | Float64Array | Uint16Array,
    nx: number,
    ny: number,
    nz: number,
    fx: number,
    fy: number,
    fz: number
): number {
    const ix = Math.max(0, Math.min(nx - 1, Math.round(fx)));
    const iy = Math.max(0, Math.min(ny - 1, Math.round(fy)));
    const iz = Math.max(0, Math.min(nz - 1, Math.round(fz)));
    return readVoxel(data, nx, ny, nz, ix, iy, iz);
}

/** Map each reference voxel center to source volume via refAffine and inv(srcAffine); trilinear sample. */
export function resampleScalarVolumeOntoReference(source: VolumeData, reference: VolumeData): VolumeData | null {
    if (!source.affine || !reference.affine) return null;
    const invSrc = invertMat4RowMajor(source.affine);
    if (!invSrc) return null;

    const [nx, ny, nz] = reference.dimensions;
    const [sx, sy, sz] = source.dimensions;
    const out = new Float32Array(nx * ny * nz);

    for (let k = 0; k < nz; k++) {
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const [px, py, pz] = voxelCenterToPatientRowMajor(reference.affine, i, j, k);
                const [fx, fy, fz, fw] = applyMat4Point(invSrc, px, py, pz);
                const iw = Math.abs(fw) > 1e-12 ? 1 / fw : 1;
                const fi = fx * iw;
                const fj = fy * iw;
                const fk = fz * iw;

                const v = sampleTrilinear(source.data, sx, sy, sz, fi, fj, fk);
                out[i + j * nx + k * nx * ny] = v;
            }
        }
    }

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < out.length; i++) {
        const v = out[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }

    return {
        header: { ...reference.header, datatypeCode: 16 },
        dimensions: [...reference.dimensions] as [number, number, number],
        data: out,
        min,
        max,
        affine: [...reference.affine],
        coordSystem: reference.coordSystem,
        geometryNotes: `resampled_from_source(${source.geometryNotes || 'no_notes'})`
    };
}

/** Nearest-neighbor resampling for label / mask volumes. */
export function resampleDiscreteVolumeOntoReference(source: VolumeData, reference: VolumeData): VolumeData | null {
    if (!source.affine || !reference.affine) return null;
    const invSrc = invertMat4RowMajor(source.affine);
    if (!invSrc) return null;

    const [nx, ny, nz] = reference.dimensions;
    const [sx, sy, sz] = source.dimensions;
    const out = new Uint8Array(nx * ny * nz);

    for (let k = 0; k < nz; k++) {
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const [px, py, pz] = voxelCenterToPatientRowMajor(reference.affine, i, j, k);
                const [fx, fy, fz, fw] = applyMat4Point(invSrc, px, py, pz);
                const iw = Math.abs(fw) > 1e-12 ? 1 / fw : 1;
                const fi = fx * iw;
                const fj = fy * iw;
                const fk = fz * iw;

                const v = sampleNearest(source.data, sx, sy, sz, fi, fj, fk);
                out[i + j * nx + k * nx * ny] = Math.max(0, Math.min(255, Math.round(v)));
            }
        }
    }

    return {
        header: { ...reference.header, datatypeCode: 2 },
        dimensions: [...reference.dimensions] as [number, number, number],
        data: out,
        min: 0,
        max: 255,
        affine: [...reference.affine],
        coordSystem: reference.coordSystem,
        geometryNotes: `resampled_labels_from_source(${source.geometryNotes || 'no_notes'})`
    };
}
