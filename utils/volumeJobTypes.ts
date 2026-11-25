export type VolumeWorkerRequest =
    | {
        requestId: number;
        kind: 'process';
        method: string;
        param1: number;
        param2: number;
        data: Float32Array;
        dimensions: [number, number, number];
        min: number;
        max: number;
        affine?: number[];
        pixDims?: number[];
        geometryNotes?: string;
        refData?: Float32Array;
        refMin?: number;
        refMax?: number;
    }
    | {
        requestId: number;
        kind: 'segment';
        method: string;
        data: Float32Array;
        dimensions: [number, number, number];
        min: number;
        max: number;
        manualThreshold: number;
        manualUpper: number;
        localKernel: number;
        localOffset: number;
        affine?: number[];
    };

export type VolumeWorkerResponse =
    | { requestId: number; type: 'progress'; pct: number }
    | { requestId: number; type: 'error'; message: string }
    | {
        requestId: number;
        type: 'result';
        kind: 'process';
        data: Float32Array;
        min: number;
        max: number;
        geometryNotes?: string;
    }
    | {
        requestId: number;
        type: 'result';
        kind: 'segment';
        data: Uint8Array;
        min: number;
        max: number;
        geometryNotes: string;
    };
