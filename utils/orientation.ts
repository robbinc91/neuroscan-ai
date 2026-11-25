import type { VolumeCoordSystem, VolumeData } from '../types';
import type { SliceOrientation } from './measure';

export type DisplayConvention = 'radiological' | 'neurological';
export type SideLetter = 'L' | 'R' | 'A' | 'P' | 'S' | 'I';

export interface SliceSideLabels {
    left: SideLetter | '';
    right: SideLetter | '';
    top: SideLetter | '';
    bottom: SideLetter | '';
}

const IDENTITY_AFFINE = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function effectiveAffine(volume: VolumeData): number[] {
    if (volume.affine && volume.affine.length >= 16) return volume.affine;
    return IDENTITY_AFFINE;
}

function affineColumn(affine: number[], col: number): [number, number, number] {
    return [affine[col], affine[4 + col], affine[8 + col]];
}

function scale(v: [number, number, number], s: number): [number, number, number] {
    return [v[0] * s, v[1] * s, v[2] * s];
}

/** Map a patient-space direction into L/R/A/P/S/I. LPS is converted to RAS first. */
export function patientLetter(
    dx: number,
    dy: number,
    dz: number,
    space?: VolumeCoordSystem
): SideLetter | '' {
    let x = dx;
    let y = dy;
    let z = dz;
    if (space === 'LPS') {
        x = -dx;
        y = -dy;
    }
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    const az = Math.abs(z);
    if (ax < 1e-8 && ay < 1e-8 && az < 1e-8) return '';
    if (ax >= ay && ax >= az) return x >= 0 ? 'R' : 'L';
    if (ay >= az) return y >= 0 ? 'A' : 'P';
    return z >= 0 ? 'S' : 'I';
}

function displayedPlusU(
    orientation: SliceOrientation,
    affine: number[]
): [number, number, number] {
    if (orientation === 'Sagittal') return affineColumn(affine, 1);
    return affineColumn(affine, 0);
}

function displayedPlusV(
    orientation: SliceOrientation,
    affine: number[]
): [number, number, number] {
    if (orientation === 'Axial') return scale(affineColumn(affine, 1), -1);
    return affineColumn(affine, 2);
}

/**
 * Radiological axial/coronal: patient right on the left of the screen.
 * Sagittal is not flipped by convention.
 */
export function sliceFlipH(
    orientation: SliceOrientation,
    volume: VolumeData | null,
    convention: DisplayConvention
): boolean {
    if (!volume) return false;
    if (orientation === 'Sagittal') return false;
    const right = patientLetter(...displayedPlusU(orientation, effectiveAffine(volume)), volume.coordSystem);
    if (convention === 'radiological') return right === 'R';
    return right === 'L';
}

export function sliceSideLabels(
    orientation: SliceOrientation,
    volume: VolumeData | null,
    flipH: boolean
): SliceSideLabels {
    const empty: SliceSideLabels = { left: '', right: '', top: '', bottom: '' };
    if (!volume) return empty;
    const affine = effectiveAffine(volume);
    const space = volume.coordSystem;
    let u = displayedPlusU(orientation, affine);
    const v = displayedPlusV(orientation, affine);
    if (flipH) u = scale(u, -1);
    return {
        right: patientLetter(u[0], u[1], u[2], space),
        left: patientLetter(-u[0], -u[1], -u[2], space),
        bottom: patientLetter(v[0], v[1], v[2], space),
        top: patientLetter(-v[0], -v[1], -v[2], space)
    };
}
