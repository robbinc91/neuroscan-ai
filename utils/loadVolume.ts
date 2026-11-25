import type { VolumeData } from '../types';
import { parseDicomFiles } from './dicomUtils';
import { parseNiftiFile } from './niftiUtils';

export function isNiftiFileName(name: string): boolean {
    const base = name.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
    return base.endsWith('.nii') || base.endsWith('.nii.gz') || base.endsWith('.hdr');
}

export function isDicomFileName(name: string): boolean {
    const base = name.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
    return base.endsWith('.dcm') || base.endsWith('.ima') || base.endsWith('.dicom');
}

/** Parse one file by extension, then NIfTI/DICOM sniff if the name is ambiguous. */
export function parseVolumeFromFile(name: string, data: ArrayBuffer): VolumeData | null {
    if (isNiftiFileName(name)) return parseNiftiFile(data);
    if (isDicomFileName(name)) return parseDicomFiles([data]);
    return parseNiftiFile(data) ?? parseDicomFiles([data]);
}

export function parseVolumeFromFiles(files: Array<{ name: string; data: ArrayBuffer }>): VolumeData | null {
    if (files.length === 0) return null;
    if (files.length === 1) return parseVolumeFromFile(files[0].name, files[0].data);
    if (files.every((f) => isNiftiFileName(f.name))) return parseNiftiFile(files[0].data);
    return parseDicomFiles(files.map((f) => f.data));
}
