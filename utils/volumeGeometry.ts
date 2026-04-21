import type { VolumeData } from '../types';

/** JSON for API / backend: voxel grid + patient-space affine. */
export function volumeGeometryJson(vol: VolumeData): string {
    return JSON.stringify({
        dimensions: vol.dimensions,
        affine_row_major: vol.affine ?? null,
        space: vol.coordSystem ?? 'UNKNOWN',
        notes: vol.geometryNotes ?? null
    });
}
