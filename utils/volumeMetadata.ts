import type { DicomTagRow, VolumeData, VolumeMetadata } from '../types';

const DATATYPE_NAMES: Record<number, string> = {
    2: 'uint8',
    4: 'int16',
    8: 'int32',
    16: 'float32',
    64: 'float64',
    512: 'uint16'
};

const BINARY_VR = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'UN']);

export function voxelSpacingMm(volume: VolumeData): [number, number, number] {
    const a = volume.affine;
    if (a && a.length >= 16) {
        const sx = Math.hypot(a[0], a[4], a[8]);
        const sy = Math.hypot(a[1], a[5], a[9]);
        const sz = Math.hypot(a[2], a[6], a[10]);
        if (sx > 1e-6 && sy > 1e-6 && sz > 1e-6) return [sx, sy, sz];
    }
    const pix = volume.header?.pixDims as number[] | undefined;
    return [
        Math.abs(pix?.[1]) || 1,
        Math.abs(pix?.[2]) || 1,
        Math.abs(pix?.[3]) || 1
    ];
}

export function formatDicomDate(raw?: string): string | undefined {
    if (!raw) return undefined;
    const s = String(raw).trim();
    if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    return s || undefined;
}

export function formatDicomTime(raw?: string): string | undefined {
    if (!raw) return undefined;
    const s = String(raw).trim();
    const m = /^(\d{2})(\d{2})(\d{2})(?:\.(\d+))?/.exec(s);
    if (!m) return s || undefined;
    return m[4] ? `${m[1]}:${m[2]}:${m[3]}.${m[4].slice(0, 3)}` : `${m[1]}:${m[2]}:${m[3]}`;
}

function personName(raw?: string): string | undefined {
    if (!raw) return undefined;
    const s = String(raw).replace(/\^/g, ' ').replace(/\s+/g, ' ').trim();
    return s || undefined;
}

function str(v: unknown): string | undefined {
    if (v == null) return undefined;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    const s = String(v).replace(/\0/g, '').trim();
    return s || undefined;
}

function clip(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function hex4(n: number): string {
    return ((n + 0x10000) & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}

export function formatDicomValue(value: unknown, vr?: string, maxLen = 240): string | undefined {
    if (value == null) return undefined;
    if (vr && BINARY_VR.has(vr)) {
        if (value instanceof DataView) return `[${vr} ${value.byteLength} bytes]`;
        if (ArrayBuffer.isView(value)) return `[${vr} ${value.byteLength} bytes]`;
        if (value instanceof ArrayBuffer) return `[${vr} ${value.byteLength} bytes]`;
        if (Array.isArray(value) && value.length > 24 && typeof value[0] === 'number') {
            return `[${vr} ${value.length} values]`;
        }
    }
    if (typeof value === 'string') {
        const s = value.replace(/\0/g, '').trim();
        return s ? clip(s, maxLen) : undefined;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (Array.isArray(value)) {
        if (value.length === 0) return undefined;
        const first = value[0] as { group?: unknown; vr?: unknown } | undefined;
        if (first && typeof first === 'object' && (first.group != null || first.vr != null)) {
            return `[SQ ${value.length} item${value.length === 1 ? '' : 's'}]`;
        }
        const parts: string[] = [];
        for (const item of value) {
            const s = formatDicomValue(item, vr, maxLen);
            if (s) parts.push(s);
        }
        if (parts.length === 0) return undefined;
        return clip(parts.join('\\'), maxLen);
    }
    if (value instanceof DataView) return `[binary ${value.byteLength} bytes]`;
    if (ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`;
    if (value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`;
    if (typeof value === 'object' && value !== null && 'value' in value) {
        return formatDicomValue((value as { value: unknown }).value, vr, maxLen);
    }
    const s = String(value).replace(/\0/g, '').trim();
    if (!s || s === '[object Object]') return undefined;
    return clip(s, maxLen);
}

export interface DicomImageLike {
    tags?: Record<string, DicomTagLike>;
    tagsFlat?: Record<string, DicomTagLike>;
    getPatientName?: () => unknown;
    getPatientID?: () => unknown;
    getStudyDate?: () => unknown;
    getStudyTime?: () => unknown;
    getModality?: () => unknown;
    getSeriesDescription?: () => unknown;
    getSeriesInstanceUID?: () => unknown;
    getSeriesNumber?: () => unknown;
    getImageDescription?: () => unknown;
    getTag?: (group: number, element: number) => DicomTagLike | null | undefined;
}

export interface DicomTagLike {
    group?: number;
    element?: number;
    vr?: string;
    value?: unknown;
    sublist?: boolean;
    isPixelData?: () => boolean;
}

export function collectDicomTags(
    image: DicomImageLike,
    describe?: (group: number, element: number) => string
): DicomTagRow[] {
    const src = image.tagsFlat && Object.keys(image.tagsFlat).length > 0
        ? image.tagsFlat
        : image.tags ?? {};
    const rows: DicomTagRow[] = [];
    const seen = new Set<string>();
    for (const key of Object.keys(src).sort()) {
        const tag = src[key];
        if (!tag || typeof tag !== 'object') continue;
        const group = Number(tag.group);
        const element = Number(tag.element);
        if (!Number.isFinite(group) || !Number.isFinite(element)) continue;
        if (group === 0x7fe0 && element === 0x0010) continue;
        if (tag.isPixelData?.()) continue;
        const vr = str(tag.vr);
        if (tag.sublist && vr !== 'SQ') continue;
        const value = formatDicomValue(tag.value, vr);
        if (value == null) continue;
        const id = `(${hex4(group)},${hex4(element)})`;
        if (seen.has(id)) continue;
        seen.add(id);
        const rawName = describe?.(group, element);
        const name = rawName && rawName !== 'PrivateData' ? rawName : (rawName || 'Private');
        rows.push({ id, name, vr, value });
    }
    return rows;
}

function tagValue(image: DicomImageLike, group: number, element: number): string | undefined {
    const tag = image.getTag?.(group, element);
    return formatDicomValue(tag?.value, tag?.vr);
}

function fromTags(tags: DicomTagRow[] | undefined, id: string): string | undefined {
    if (!tags) return undefined;
    const row = tags.find((t) => t.id === id);
    return row?.value || undefined;
}

export function metadataFromNifti(volume: VolumeData): VolumeMetadata {
    const h = volume.header ?? {};
    const spacingMm = voxelSpacingMm(volume);
    return {
        source: 'nifti',
        description: str(h.descrip) || str(h.description),
        datatype: DATATYPE_NAMES[h.datatypeCode] ?? (h.datatypeCode != null ? String(h.datatypeCode) : undefined),
        dimensions: volume.dimensions,
        spacingMm,
        coordSystem: volume.coordSystem,
        geometryNotes: volume.geometryNotes,
        qformCode: h.qform_code,
        sformCode: h.sform_code,
        modality: 'MR'
    };
}

export function metadataFromDicom(
    first: DicomImageLike,
    volume: VolumeData,
    options?: { describe?: (group: number, element: number) => string }
): VolumeMetadata {
    const tags = collectDicomTags(first, options?.describe);
    const pick = (getter: () => unknown, id: string) =>
        str(getter()) || fromTags(tags, id);

    return {
        source: 'dicom',
        patientName: personName(pick(() => first.getPatientName?.(), '(0010,0010)')),
        patientId: pick(() => first.getPatientID?.(), '(0010,0020)'),
        patientSex: tagValue(first, 0x0010, 0x0040) || fromTags(tags, '(0010,0040)'),
        patientBirthDate: formatDicomDate(tagValue(first, 0x0010, 0x0030) || fromTags(tags, '(0010,0030)')),
        studyDate: formatDicomDate(pick(() => first.getStudyDate?.(), '(0008,0020)')),
        studyTime: formatDicomTime(pick(() => first.getStudyTime?.(), '(0008,0030)')),
        studyDescription: tagValue(first, 0x0008, 0x1030) || fromTags(tags, '(0008,1030)'),
        seriesDescription: pick(() => first.getSeriesDescription?.(), '(0008,103E)')
            || str(first.getImageDescription?.()),
        accessionNumber: tagValue(first, 0x0008, 0x0050) || fromTags(tags, '(0008,0050)'),
        institution: tagValue(first, 0x0008, 0x0080) || fromTags(tags, '(0008,0080)'),
        protocolName: tagValue(first, 0x0018, 0x1030) || fromTags(tags, '(0018,1030)'),
        modality: pick(() => first.getModality?.(), '(0008,0060)'),
        seriesUid: pick(() => first.getSeriesInstanceUID?.(), '(0020,000E)'),
        seriesNumber: pick(() => first.getSeriesNumber?.(), '(0020,0011)'),
        manufacturer: tagValue(first, 0x0008, 0x0070) || fromTags(tags, '(0008,0070)'),
        datatype: 'float32',
        dimensions: volume.dimensions,
        spacingMm: voxelSpacingMm(volume),
        coordSystem: volume.coordSystem,
        geometryNotes: volume.geometryNotes,
        tags
    };
}

export function ensureVolumeMetadata(volume: VolumeData): VolumeMetadata {
    if (volume.metadata) {
        return {
            ...volume.metadata,
            dimensions: volume.dimensions,
            spacingMm: volume.metadata.spacingMm ?? voxelSpacingMm(volume),
            coordSystem: volume.metadata.coordSystem ?? volume.coordSystem,
            geometryNotes: volume.metadata.geometryNotes ?? volume.geometryNotes
        };
    }
    const h = volume.header ?? {};
    if (h.dicomGeometry) return metadataFromDicom({}, volume);
    return metadataFromNifti(volume);
}

export function patientFooterLabel(meta?: VolumeMetadata | null): string {
    if (!meta) return 'Patient: —';
    const who =
        meta.patientId && meta.patientName ? `${meta.patientName}  ${meta.patientId}`
        : meta.patientId ? meta.patientId
        : meta.patientName ? meta.patientName
        : null;
    if (who) return `Patient: ${who}`;
    if (meta.source === 'dicom') return 'Patient: (no ID in DICOM header)';
    if (meta.sourceName) return `Patient: — | ${meta.sourceName}`;
    if (meta.source === 'nifti') return 'Patient: — | NIfTI';
    return 'Patient: —';
}
