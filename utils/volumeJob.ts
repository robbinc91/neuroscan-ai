import type { VolumeData } from '../types';
import type { VolumeWorkerRequest, VolumeWorkerResponse } from './volumeJobTypes';

export class VolumeJobCancelled extends Error {
    constructor() {
        super('Volume job cancelled');
        this.name = 'VolumeJobCancelled';
    }
}

type JobKind = 'process' | 'segment';

interface JobHandle<T> {
    promise: Promise<T>;
    cancel: () => void;
}

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, {
    kind: JobKind;
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    onProgress?: (pct: number) => void;
}>();

function getWorker(): Worker {
    if (!worker) {
        worker = new Worker(new URL('../workers/volumeWorker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<VolumeWorkerResponse>) => {
            const msg = event.data;
            const job = pending.get(msg.requestId);
            if (!job) return;
            if (msg.type === 'progress') {
                job.onProgress?.(msg.pct);
                return;
            }
            pending.delete(msg.requestId);
            if (msg.type === 'error') {
                job.reject(new Error(msg.message));
                return;
            }
            job.resolve(msg);
        };
        worker.onerror = (event) => {
            const err = new Error(event.message || 'Volume worker crashed');
            for (const job of pending.values()) job.reject(err);
            pending.clear();
            worker?.terminate();
            worker = null;
        };
    }
    return worker;
}

export function cancelVolumeJob(): void {
    if (!worker && pending.size === 0) return;
    for (const job of pending.values()) job.reject(new VolumeJobCancelled());
    pending.clear();
    worker?.terminate();
    worker = null;
}

function copyFloat32(data: ArrayLike<number>): Float32Array {
    return data instanceof Float32Array ? new Float32Array(data) : Float32Array.from(data as ArrayLike<number>);
}

export function runProcessJob(
    volume: VolumeData,
    method: string,
    param1: number,
    param2: number,
    options?: {
        reference?: VolumeData | null;
        highAccuracy?: boolean;
        onProgress?: (pct: number) => void;
    }
): JobHandle<{ data: Float32Array; min: number; max: number; geometryNotes?: string }> {
    const requestId = nextRequestId++;
    const data = copyFloat32(volume.data);
    const refData = options?.reference ? copyFloat32(options.reference.data) : undefined;
    const transfer: Transferable[] = [data.buffer];
    if (refData) transfer.push(refData.buffer);

    const request: VolumeWorkerRequest = {
        requestId,
        kind: 'process',
        method,
        param1,
        param2,
        data,
        dimensions: volume.dimensions,
        min: volume.min,
        max: volume.max,
        affine: volume.affine,
        pixDims: volume.header?.pixDims,
        geometryNotes: volume.geometryNotes,
        refData,
        refMin: options?.reference?.min,
        refMax: options?.reference?.max,
        highAccuracy: options?.highAccuracy
    };

    const promise = new Promise<{ data: Float32Array; min: number; max: number; geometryNotes?: string }>((resolve, reject) => {
        pending.set(requestId, {
            kind: 'process',
            resolve: (value) => {
                const msg = value as Extract<VolumeWorkerResponse, { type: 'result'; kind: 'process' }>;
                resolve({ data: msg.data, min: msg.min, max: msg.max, geometryNotes: msg.geometryNotes });
            },
            reject,
            onProgress: options?.onProgress
        });
        getWorker().postMessage(request, transfer);
    });

    return {
        promise,
        cancel: cancelVolumeJob
    };
}

export function runSegmentJob(
    volume: VolumeData,
    method: string,
    params: {
        manualThreshold: number;
        manualUpper: number;
        localKernel: number;
        localOffset: number;
    },
    options?: { onProgress?: (pct: number) => void }
): JobHandle<{ data: Uint8Array; min: number; max: number; geometryNotes: string }> {
    const requestId = nextRequestId++;
    const data = copyFloat32(volume.data);
    const request: VolumeWorkerRequest = {
        requestId,
        kind: 'segment',
        method,
        data,
        dimensions: volume.dimensions,
        min: volume.min,
        max: volume.max,
        manualThreshold: params.manualThreshold,
        manualUpper: params.manualUpper,
        localKernel: params.localKernel,
        localOffset: params.localOffset,
        affine: volume.affine
    };

    const promise = new Promise<{ data: Uint8Array; min: number; max: number; geometryNotes: string }>((resolve, reject) => {
        pending.set(requestId, {
            kind: 'segment',
            resolve: (value) => {
                const msg = value as Extract<VolumeWorkerResponse, { type: 'result'; kind: 'segment' }>;
                resolve({ data: msg.data, min: msg.min, max: msg.max, geometryNotes: msg.geometryNotes });
            },
            reject,
            onProgress: options?.onProgress
        });
        getWorker().postMessage(request, [data.buffer]);
    });

    return {
        promise,
        cancel: cancelVolumeJob
    };
}
