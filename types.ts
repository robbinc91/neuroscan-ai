
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

export enum ProcessingMethod {
    N4 = 'N4 Bias Correction',
    HistogramMatching = 'Histogram Matching',
    AnisotropicDiffusion = 'Anisotropic Diffusion',
    NonLocalMeans = 'Non-local Means'
}

export type ViewportTool = 'pan' | 'zoom' | 'wl' | 'measure' | 'brush' | 'eraser';

export interface MetricData {
    name: string;
    value: number;
    unit: string;
    reference?: string;
}

export interface ScanMetadata {
    id: string;
    patientId: string;
    modality: string;
    date: string;
    dimensions: [number, number, number];
    spacing: [number, number, number];
}

export interface SegmentationStats {
    label: string;
    volume: number;
    intensityMean: number;
    intensityStd: number;
}

export interface VolumeData {
    header: any;
    data: Float32Array | Int16Array | Uint8Array | Int32Array | Float64Array | Uint16Array;
    dimensions: [number, number, number];
    min: number;
    max: number;
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
}
