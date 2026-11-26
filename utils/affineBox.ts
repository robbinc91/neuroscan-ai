import type { VolumeData } from '../types';
import { invertMat4RowMajor, multiplyMat4, transformPoint } from './mat4';
import { voxelSpacingMm } from './volumeMetadata';

function pixDimsAffine(volume: VolumeData): number[] {
    const [sx, sy, sz] = voxelSpacingMm(volume);
    return [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1];
}

function toColumnMajor(m: number[]): Float32Array {
    return new Float32Array([
        m[0], m[4], m[8], m[12],
        m[1], m[5], m[9], m[13],
        m[2], m[6], m[10], m[14],
        m[3], m[7], m[11], m[15]
    ]);
}

/** Corner of the voxel grid in patient mm: index 0 and N (voxel edges), not pixDims AABB. */
export function volumeEdgeCorners(volume: VolumeData): [number, number, number][] {
    const A = volume.affine && volume.affine.length >= 16 ? volume.affine : pixDimsAffine(volume);
    const [nx, ny, nz] = volume.dimensions;
    const corners: [number, number, number][] = [];
    for (const i of [0, nx]) {
        for (const j of [0, ny]) {
            for (const k of [0, nz]) {
                corners.push(transformPoint(A, i, j, k));
            }
        }
    }
    return corners;
}

/**
 * Column-major mat4 mapping display-world (OBB centered, max edge = 1) → texture [0,1]^3.
 * Raycast the unit cube in texture space so oblique / anisotropic affines are true OBBs.
 */
export function displayWorldToTexColumnMajor(volume: VolumeData): Float32Array {
    const A = volume.affine && volume.affine.length >= 16 ? volume.affine : pixDimsAffine(volume);
    const [nx, ny, nz] = volume.dimensions;
    const corners = volumeEdgeCorners(volume);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const c of corners) {
        if (c[0] < minX) minX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[2] < minZ) minZ = c[2];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] > maxY) maxY = c[1];
        if (c[2] > maxZ) maxZ = c[2];
    }
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-3);
    const scale = 1 / extent;

    const sDim = [nx, 0, 0, 0, 0, ny, 0, 0, 0, 0, nz, 0, 0, 0, 0, 1];
    const tCenter = [1, 0, 0, -cx, 0, 1, 0, -cy, 0, 0, 1, -cz, 0, 0, 0, 1];
    const sScale = [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1];
    const texToDisplay = multiplyMat4(sScale, multiplyMat4(tCenter, multiplyMat4(A, sDim)));
    const displayToTex = invertMat4RowMajor(texToDisplay);
    if (!displayToTex) {
        return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    }
    return toColumnMajor(displayToTex);
}
