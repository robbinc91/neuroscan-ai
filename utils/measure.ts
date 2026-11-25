import type { VolumeData } from '../types';
import { transformPoint } from './mat4';

export type SliceOrientation = 'Axial' | 'Coronal' | 'Sagittal';

export interface SlicePoint {
    u: number;
    v: number;
}

export interface SliceMeasurement {
    id: number;
    orientation: SliceOrientation;
    slice: number;
    start: SlicePoint;
    end: SlicePoint;
}

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

function clampIndex(v: number, dim: number): number {
    if (dim <= 0) return 0;
    return v < 0 ? 0 : v > dim - 1 ? dim - 1 : v;
}

/** Slice index used by generateSliceBitmap (floor) so overlays match the pixels on screen. */
export function displayedSliceIndex(slice: number): number {
    return Math.floor(slice);
}

/**
 * Map a displayed slice coordinate to a continuous voxel index.
 * Matches generateSliceBitmap: axial Y is flipped (v=0 is the high-Y edge).
 * Display (0,0) is the top-left corner of the first pixel; 1 unit = 1 voxel.
 */
export function sliceUvToVoxel(
    orientation: SliceOrientation,
    u: number,
    v: number,
    slice: number,
    dimensions: [number, number, number]
): [number, number, number] {
    const [dx, dy, dz] = dimensions;
    const plane = displayedSliceIndex(slice) + 0.5;
    if (orientation === 'Axial') {
        return [clamp(u, 0, dx), clamp(dy - v, 0, dy), plane];
    }
    if (orientation === 'Coronal') {
        return [clamp(u, 0, dx), plane, clamp(v, 0, dz)];
    }
    return [plane, clamp(u, 0, dy), clamp(v, 0, dz)];
}

/**
 * Integer voxel for a displayed pixel, matching generateSliceBitmap sampling.
 * Axial Y is flipped: display v=0 is voxel y = dimY-1.
 */
export function sliceUvToVoxelIndex(
    orientation: SliceOrientation,
    u: number,
    v: number,
    slice: number,
    dimensions: [number, number, number]
): [number, number, number] {
    const [dx, dy, dz] = dimensions;
    const [x, y, z] = sliceUvToVoxel(orientation, Math.floor(u) + 0.5, Math.floor(v) + 0.5, slice, dimensions);
    return [clampIndex(Math.floor(x), dx), clampIndex(Math.floor(y), dy), clampIndex(Math.floor(z), dz)];
}

/** In-plane voxel indices (as stored on the crosshair) → displayed pixel. */
export function inPlaneVoxelToDisplayUv(
    orientation: SliceOrientation,
    u: number,
    v: number,
    dimensions: [number, number, number]
): SlicePoint {
    if (orientation === 'Axial') {
        return { u, v: dimensions[1] - 1 - v };
    }
    return { u, v };
}

/** Hold Shift while dragging to lock the ruler to the nearer image axis. */
export function axisLockPoint(start: SlicePoint, end: SlicePoint, lock: boolean): SlicePoint {
    if (!lock) return end;
    if (Math.abs(end.u - start.u) >= Math.abs(end.v - start.v)) {
        return { u: end.u, v: start.v };
    }
    return { u: start.u, v: end.v };
}

export function measurementLengthMm(
    volume: VolumeData,
    orientation: SliceOrientation,
    slice: number,
    start: SlicePoint,
    end: SlicePoint
): number {
    const a = sliceUvToVoxel(orientation, start.u, start.v, slice, volume.dimensions);
    const b = sliceUvToVoxel(orientation, end.u, end.v, slice, volume.dimensions);
    return voxelDistanceMm(volume, a, b);
}

export function voxelDistanceMm(
    volume: VolumeData,
    a: [number, number, number],
    b: [number, number, number]
): number {
    if (volume.affine && volume.affine.length >= 16) {
        const pa = transformPoint(volume.affine, a[0], a[1], a[2]);
        const pb = transformPoint(volume.affine, b[0], b[1], b[2]);
        return Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
    }
    const pix = volume.header?.pixDims as number[] | undefined;
    const sx = Math.abs(pix?.[1]) || 1;
    const sy = Math.abs(pix?.[2]) || 1;
    const sz = Math.abs(pix?.[3]) || 1;
    return Math.hypot((b[0] - a[0]) * sx, (b[1] - a[1]) * sy, (b[2] - a[2]) * sz);
}

export function formatLengthMm(mm: number): string {
    if (!Number.isFinite(mm)) return '—';
    if (mm >= 100) return `${mm.toFixed(1)} mm`;
    return `${mm.toFixed(2)} mm`;
}

export function pickSliceUv(
    canvas: HTMLCanvasElement,
    clientX: number,
    clientY: number,
    options?: { clamp?: boolean }
): SlicePoint | null {
    const imgW = canvas.width;
    const imgH = canvas.height;
    const rect = canvas.getBoundingClientRect();
    if (imgW <= 0 || imgH <= 0 || rect.width <= 0 || rect.height <= 0) return null;
    const scale = Math.min(rect.width / imgW, rect.height / imgH);
    const dispW = imgW * scale;
    const dispH = imgH * scale;
    const ox = rect.left + (rect.width - dispW) / 2;
    const oy = rect.top + (rect.height - dispH) / 2;
    const u = (clientX - ox) / scale;
    const v = (clientY - oy) / scale;
    if (options?.clamp) {
        return { u: clamp(u, 0, imgW), v: clamp(v, 0, imgH) };
    }
    if (u < 0 || v < 0 || u > imgW || v > imgH) return null;
    return { u, v };
}
