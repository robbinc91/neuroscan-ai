
export enum ViewMode {
    FourUp = 'FOUR_UP',
    Axial = 'AXIAL',
    Coronal = 'CORONAL',
    Sagittal = 'SAGITTAL',
    ThreeD = '3D'
}

export enum ToolCategory {
    Viewer = 'VIEWER',
    Processing = 'PROCESSING',
    Segmentation = 'SEGMENTATION',
    Analysis = 'ANALYSIS',
    Reporting = 'REPORTING',
    Comparison = 'COMPARISON'
}

export type ViewportTool = 'crosshair' | 'pan' | 'zoom' | 'wl' | 'measure' | 'brush' | 'eraser';

export interface ScanMetadata {
    id: string;
    patientId: string;
    modality: string;
    date: string;
    dimensions: [number, number, number];
    spacing: [number, number, number];
}

export interface WindowLevel {
    width: number;
    center: number;
}

export interface DicomTagRow {
    id: string;
    name: string;
    vr?: string;
    value: string;
}

export interface VolumeMetadata {
    source: 'nifti' | 'dicom' | 'unknown';
    sourceName?: string;
    patientId?: string;
    patientName?: string;
    patientSex?: string;
    patientBirthDate?: string;
    studyDate?: string;
    studyTime?: string;
    studyDescription?: string;
    seriesDescription?: string;
    accessionNumber?: string;
    institution?: string;
    protocolName?: string;
    modality?: string;
    seriesUid?: string;
    seriesNumber?: string;
    manufacturer?: string;
    description?: string;
    datatype?: string;
    dimensions: [number, number, number];
    spacingMm: [number, number, number];
    coordSystem?: string;
    geometryNotes?: string;
    qformCode?: number;
    sformCode?: number;
    /** Flattened DICOM header (pixel data omitted). */
    tags?: DicomTagRow[];
}

export interface SegmentationStats {
    label: string;
    volume: number;
    intensityMean: number;
    intensityStd: number;
}

/** Patient/world space for `affine` (DICOM LPS; NIfTI follows file qform/sform, often scanner RAS). */
export type VolumeCoordSystem = 'LPS' | 'RAS' | 'SCANNER_ANAT' | 'MNI_152' | 'UNKNOWN';

export interface VolumeData {
    header: any;
    data: Float32Array | Int16Array | Uint8Array | Int32Array | Float64Array | Uint16Array;
    dimensions: [number, number, number];
    min: number;
    max: number;
    /**
     * Row-major 4x4: maps voxel index column [i, j, k, 1]^T to homogeneous patient mm.
     * i = fastest dim (dim[0]), j = dim[1], k = dim[2]. Voxel centers use (i+0.5, j+0.5, k+0.5).
     */
    affine?: number[];
    coordSystem?: VolumeCoordSystem;
    /** e.g. multi-series selection, missing IOP fallback */
    geometryNotes?: string;
    metadata?: VolumeMetadata;
}

export interface Study {
    id: string;
    name: string;
    volume: VolumeData;
    segmentation: VolumeData | null;
    date: Date;
    color: string;
}

export interface ReportImages {
    axial: string[];
    coronal: string[];
    sagittal: string[];
    threeD: string[];
}

export interface ViewportHandle {
    getReportImages: () => Promise<ReportImages>;
    undoPaint: () => boolean;
}
