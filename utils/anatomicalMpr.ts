import type { VolumeData } from '../types';
import type { SliceOrientation } from './measure';
import { invertMat4RowMajor, transformPoint, voxelCenterToPatientRowMajor } from './mat4';
import { voxelSpacingMm } from './volumeMetadata';
import { sampleNearest, sampleTrilinear } from './resampleVolume';
import type { DisplayConvention } from './orientation';

export interface MprPlane {
    width: number;
    height: number;
    spacing: number;
    origin: [number, number, number];
    uDir: [number, number, number];
    vDir: [number, number, number];
    normal: [number, number, number];
    sliceIndex: number;
    sliceCount: number;
    invAffine: number[];
}

function add(a: [number, number, number], b: [number, number, number], s = 1): [number, number, number] {
    return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}

function dot(a: [number, number, number], b: [number, number, number]): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function scale(a: [number, number, number], s: number): [number, number, number] {
    return [a[0] * s, a[1] * s, a[2] * s];
}

function rasPatientAxes(volume: VolumeData): { R: [number, number, number]; A: [number, number, number]; S: [number, number, number] } {
    if (volume.coordSystem === 'LPS') {
        return { R: [-1, 0, 0], A: [0, -1, 0], S: [0, 0, 1] };
    }
    return { R: [1, 0, 0], A: [0, 1, 0], S: [0, 0, 1] };
}

export function volumePatientCorners(volume: VolumeData): [number, number, number][] {
    const a = volume.affine;
    if (!a || a.length < 16) return [];
    const [nx, ny, nz] = volume.dimensions;
    const corners: [number, number, number][] = [];
    for (const i of [0, nx - 1]) {
        for (const j of [0, ny - 1]) {
            for (const k of [0, nz - 1]) {
                corners.push(voxelCenterToPatientRowMajor(a, i, j, k));
            }
        }
    }
    return corners;
}

export function patientAabb(volume: VolumeData): { min: [number, number, number]; max: [number, number, number] } | null {
    const corners = volumePatientCorners(volume);
    if (corners.length === 0) return null;
    const min: [number, number, number] = [...corners[0]];
    const max: [number, number, number] = [...corners[0]];
    for (const c of corners) {
        for (let i = 0; i < 3; i++) {
            if (c[i] < min[i]) min[i] = c[i];
            if (c[i] > max[i]) max[i] = c[i];
        }
    }
    return { min, max };
}

export function patientVolumeCenter(volume: VolumeData): [number, number, number] {
    const [nx, ny, nz] = volume.dimensions;
    if (volume.affine && volume.affine.length >= 16) {
        return voxelCenterToPatientRowMajor(volume.affine, (nx - 1) / 2, (ny - 1) / 2, (nz - 1) / 2);
    }
    return [nx / 2, ny / 2, nz / 2];
}

/** Longest AABB edge in patient mm — used to scale the 3D camera. */
export function patientAabbMaxExtent(volume: VolumeData): number {
    const box = patientAabb(volume);
    if (!box) {
        const [sx, sy, sz] = voxelSpacingMm(volume);
        const [nx, ny, nz] = volume.dimensions;
        return Math.max(nx * sx, ny * sy, nz * sz) || 1;
    }
    return Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2], 1);
}

function planeAxes(
    orientation: SliceOrientation,
    volume: VolumeData,
    convention: DisplayConvention
): { uDir: [number, number, number]; vDir: [number, number, number]; normal: [number, number, number] } {
    const { R, A, S } = rasPatientAxes(volume);
    const right = convention === 'radiological' ? scale(R, -1) : R;
    if (orientation === 'Axial') return { uDir: right, vDir: scale(A, -1), normal: S };
    if (orientation === 'Coronal') return { uDir: right, vDir: scale(S, -1), normal: A };
    return { uDir: A, vDir: scale(S, -1), normal: R };
}

export function buildMprPlane(
    volume: VolumeData,
    orientation: SliceOrientation,
    pos: { x: number; y: number; z: number },
    convention: DisplayConvention
): MprPlane | null {
    if (!volume.affine || volume.affine.length < 16) return null;
    const invAffine = invertMat4RowMajor(volume.affine);
    if (!invAffine) return null;
    const box = patientAabb(volume);
    if (!box) return null;

    const { uDir, vDir, normal } = planeAxes(orientation, volume, convention);
    const [sx, sy] = voxelSpacingMm(volume);
    const spacing = Math.max(0.25, Math.min(sx, sy));
    const corners = volumePatientCorners(volume);
    const extentAlong = (dir: [number, number, number]) => {
        let lo = Infinity;
        let hi = -Infinity;
        for (const c of corners) {
            const d = dot(c, dir);
            if (d < lo) lo = d;
            if (d > hi) hi = d;
        }
        return Math.max(spacing, hi - lo);
    };
    const width = Math.max(32, Math.min(512, Math.round(extentAlong(uDir) / spacing)));
    const height = Math.max(32, Math.min(512, Math.round(extentAlong(vDir) / spacing)));
    const center: [number, number, number] = [
        (box.min[0] + box.max[0]) / 2,
        (box.min[1] + box.max[1]) / 2,
        (box.min[2] + box.max[2]) / 2
    ];
    const focus = voxelCenterToPatientRowMajor(volume.affine, pos.x, pos.y, pos.z);
    const t = dot(add(focus, center, -1), normal);
    const origin = add(add(center, normal, t), add(scale(uDir, -0.5 * width * spacing), scale(vDir, -0.5 * height * spacing)));

    const nMin = dot(box.min, normal);
    const nMax = dot(box.max, normal);
    const span = Math.max(spacing, Math.abs(nMax - nMin));
    const sliceCount = Math.max(1, Math.round(span / spacing));
    const sliceIndex = Math.max(0, Math.min(sliceCount - 1, Math.round((dot(focus, normal) - Math.min(nMin, nMax)) / spacing)));

    return { width, height, spacing, origin, uDir, vDir, normal, sliceIndex, sliceCount, invAffine };
}

export function mprPatientAt(plane: MprPlane, u: number, v: number): [number, number, number] {
    return add(add(plane.origin, plane.uDir, (u + 0.5) * plane.spacing), plane.vDir, (v + 0.5) * plane.spacing);
}

export function mprUvToVoxelContinuous(
    volume: VolumeData,
    plane: MprPlane,
    u: number,
    v: number
): [number, number, number] {
    const p = mprPatientAt(plane, u, v);
    const ijk = transformPoint(plane.invAffine, p[0], p[1], p[2]);
    const [nx, ny, nz] = volume.dimensions;
    return [
        Math.max(0, Math.min(nx - 1, ijk[0])),
        Math.max(0, Math.min(ny - 1, ijk[1])),
        Math.max(0, Math.min(nz - 1, ijk[2]))
    ];
}

export function mprUvToVoxel(
    volume: VolumeData,
    plane: MprPlane,
    u: number,
    v: number
): [number, number, number] {
    const ijk = mprUvToVoxelContinuous(volume, plane, u, v);
    const [nx, ny, nz] = volume.dimensions;
    return [
        Math.max(0, Math.min(nx - 1, Math.floor(ijk[0]))),
        Math.max(0, Math.min(ny - 1, Math.floor(ijk[1]))),
        Math.max(0, Math.min(nz - 1, Math.floor(ijk[2])))
    ];
}

export function voxelToMprUv(
    volume: VolumeData,
    plane: MprPlane,
    x: number,
    y: number,
    z: number
): { u: number; v: number } {
    if (!volume.affine || volume.affine.length < 16) return { u: 0, v: 0 };
    const p = voxelCenterToPatientRowMajor(volume.affine, x, y, z);
    const dx = p[0] - plane.origin[0];
    const dy = p[1] - plane.origin[1];
    const dz = p[2] - plane.origin[2];
    return {
        u: (dx * plane.uDir[0] + dy * plane.uDir[1] + dz * plane.uDir[2]) / plane.spacing - 0.5,
        v: (dx * plane.vDir[0] + dy * plane.vDir[1] + dz * plane.vDir[2]) / plane.spacing - 0.5
    };
}

export function mprMeasurementMm(plane: MprPlane, start: { u: number; v: number }, end: { u: number; v: number }): number {
    const a = mprPatientAt(plane, start.u, start.v);
    const b = mprPatientAt(plane, end.u, end.v);
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function samplePatientScalar(volume: VolumeData, p: [number, number, number]): number {
    const inv = volume.affine && volume.affine.length >= 16 ? invertMat4RowMajor(volume.affine) : null;
    if (!inv) return volume.min;
    const ijk = transformPoint(inv, p[0], p[1], p[2]);
    const [nx, ny, nz] = volume.dimensions;
    if (ijk[0] < -0.5 || ijk[1] < -0.5 || ijk[2] < -0.5 || ijk[0] > nx || ijk[1] > ny || ijk[2] > nz) {
        return volume.min;
    }
    return sampleTrilinear(volume.data, nx, ny, nz, ijk[0], ijk[1], ijk[2]);
}

export function samplePatientLabel(volume: VolumeData, p: [number, number, number]): number {
    const inv = volume.affine && volume.affine.length >= 16 ? invertMat4RowMajor(volume.affine) : null;
    if (!inv) return 0;
    const ijk = transformPoint(inv, p[0], p[1], p[2]);
    const [nx, ny, nz] = volume.dimensions;
    if (ijk[0] < -0.5 || ijk[1] < -0.5 || ijk[2] < -0.5 || ijk[0] > nx - 0.5 || ijk[1] > ny - 0.5 || ijk[2] > nz - 0.5) {
        return 0;
    }
    return sampleNearest(volume.data, nx, ny, nz, ijk[0], ijk[1], ijk[2]);
}

export function sampleMprScalar(volume: VolumeData, plane: MprPlane, u: number, v: number): number {
    const p = mprPatientAt(plane, u, v);
    const ijk = transformPoint(plane.invAffine, p[0], p[1], p[2]);
    const [nx, ny, nz] = volume.dimensions;
    if (ijk[0] < -0.5 || ijk[1] < -0.5 || ijk[2] < -0.5 || ijk[0] > nx || ijk[1] > ny || ijk[2] > nz) return volume.min;
    return sampleTrilinear(volume.data, nx, ny, nz, ijk[0], ijk[1], ijk[2]);
}

export function sampleMprLabel(volume: VolumeData, plane: MprPlane, u: number, v: number): number {
    const inv = volume.affine && volume.affine.length >= 16 ? invertMat4RowMajor(volume.affine) : null;
    if (!inv) return 0;
    const p = mprPatientAt(plane, u, v);
    const ijk = transformPoint(inv, p[0], p[1], p[2]);
    const [nx, ny, nz] = volume.dimensions;
    return sampleNearest(volume.data, nx, ny, nz, ijk[0], ijk[1], ijk[2]);
}

export function setAnatomicalSlice(
    volume: VolumeData,
    orientation: SliceOrientation,
    pos: { x: number; y: number; z: number },
    sliceIndex: number,
    convention: DisplayConvention
): { x: number; y: number; z: number } {
    const plane = buildMprPlane(volume, orientation, pos, convention);
    if (!plane || !volume.affine) {
        const [nx, ny, nz] = volume.dimensions;
        if (orientation === 'Axial') return { ...pos, z: Math.max(0, Math.min(nz - 1, sliceIndex)) };
        if (orientation === 'Coronal') return { ...pos, y: Math.max(0, Math.min(ny - 1, sliceIndex)) };
        return { ...pos, x: Math.max(0, Math.min(nx - 1, sliceIndex)) };
    }
    const box = patientAabb(volume);
    if (!box) return pos;
    const nMin = Math.min(dot(box.min, plane.normal), dot(box.max, plane.normal));
    const focus = voxelCenterToPatientRowMajor(volume.affine, pos.x, pos.y, pos.z);
    const current = dot(focus, plane.normal);
    const target = nMin + (sliceIndex + 0.5) * plane.spacing;
    const nextP = add(focus, plane.normal, target - current);
    const ijk = transformPoint(plane.invAffine, nextP[0], nextP[1], nextP[2]);
    const [nx, ny, nz] = volume.dimensions;
    return {
        x: Math.max(0, Math.min(nx - 1, ijk[0])),
        y: Math.max(0, Math.min(ny - 1, ijk[1])),
        z: Math.max(0, Math.min(nz - 1, ijk[2]))
    };
}

export function stepAnatomicalSlice(
    volume: VolumeData,
    orientation: SliceOrientation,
    pos: { x: number; y: number; z: number },
    delta: number,
    convention: DisplayConvention
): { x: number; y: number; z: number } {
    const plane = buildMprPlane(volume, orientation, pos, convention);
    const idx = plane ? plane.sliceIndex : orientation === 'Axial' ? pos.z : orientation === 'Coronal' ? pos.y : pos.x;
    const count = plane ? plane.sliceCount : orientation === 'Axial' ? volume.dimensions[2] : orientation === 'Coronal' ? volume.dimensions[1] : volume.dimensions[0];
    const next = ((idx + delta) % count + count) % count;
    return setAnatomicalSlice(volume, orientation, pos, next, convention);
}
