import type { VolumeData } from '../types';
import { listDicomSeries, parseDicomFiles, type DicomSeriesChoice } from './dicomUtils';
import { parseNiftiFile, parseNiftiFileAsync } from './niftiUtils';

export type { DicomSeriesChoice };

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

export function parseVolumeFromFiles(
    files: Array<{ name: string; data: ArrayBuffer }>,
    seriesUid?: string
): VolumeData | null {
    if (files.length === 0) return null;
    if (files.length === 1 && !seriesUid) return parseVolumeFromFile(files[0].name, files[0].data);
    const nifti = files.filter((f) => isNiftiFileName(f.name));
    if (nifti.length > 0 && !seriesUid) return parseNiftiFile(nifti[0].data);
    return parseDicomFiles(files.map((f) => f.data), seriesUid);
}

export async function parseVolumeFromFileAsync(name: string, data: ArrayBuffer): Promise<VolumeData | null> {
    if (isNiftiFileName(name)) return parseNiftiFileAsync(data);
    if (isDicomFileName(name)) return parseDicomFiles([data]);
    return (await parseNiftiFileAsync(data)) ?? parseDicomFiles([data]);
}

export async function parseVolumeFromFilesAsync(
    files: Array<{ name: string; data: ArrayBuffer }>,
    seriesUid?: string
): Promise<VolumeData | null> {
    if (files.length === 0) return null;
    if (files.length === 1 && !seriesUid) return parseVolumeFromFileAsync(files[0].name, files[0].data);
    const nifti = files.filter((f) => isNiftiFileName(f.name));
    if (nifti.length > 0 && !seriesUid) return parseNiftiFileAsync(nifti[0].data);
    return parseDicomFiles(files.map((f) => f.data), seriesUid);
}

export function dicomSeriesInFiles(files: Array<{ name: string; data: ArrayBuffer }>): DicomSeriesChoice[] {
    const dcm = files.filter((f) => !isNiftiFileName(f.name));
    if (dcm.length === 0) return [];
    return listDicomSeries(dcm.map((f) => f.data));
}
