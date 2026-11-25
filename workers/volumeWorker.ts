import { processVolumeData, segmentVolumeData } from '../utils/volumeProcessing';
import type { VolumeWorkerRequest, VolumeWorkerResponse } from '../utils/volumeJobTypes';

const ctx = self as unknown as Worker;

ctx.onmessage = async (event: MessageEvent<VolumeWorkerRequest>) => {
    const msg = event.data;
    const requestId = msg.requestId;
    const onProgress = (pct: number) => {
        const res: VolumeWorkerResponse = { requestId, type: 'progress', pct };
        ctx.postMessage(res);
    };

    try {
        if (msg.kind === 'process') {
            const result = await processVolumeData({
                method: msg.method,
                data: msg.data,
                dimensions: msg.dimensions,
                min: msg.min,
                max: msg.max,
                param1: msg.param1,
                param2: msg.param2,
                affine: msg.affine,
                pixDims: msg.pixDims,
                geometryNotes: msg.geometryNotes,
                refData: msg.refData,
                refMin: msg.refMin,
                refMax: msg.refMax,
                onProgress
            });
            const res: VolumeWorkerResponse = {
                requestId,
                type: 'result',
                kind: 'process',
                data: result.data,
                min: result.min,
                max: result.max,
                geometryNotes: result.geometryNotes
            };
            ctx.postMessage(res, [result.data.buffer]);
            return;
        }

        const result = await segmentVolumeData({
            method: msg.method,
            data: msg.data,
            dimensions: msg.dimensions,
            min: msg.min,
            max: msg.max,
            manualThreshold: msg.manualThreshold,
            manualUpper: msg.manualUpper,
            localKernel: msg.localKernel,
            localOffset: msg.localOffset,
            affine: msg.affine,
            onProgress
        });
        const res: VolumeWorkerResponse = {
            requestId,
            type: 'result',
            kind: 'segment',
            data: result.data,
            min: result.min,
            max: result.max,
            geometryNotes: result.geometryNotes
        };
        ctx.postMessage(res, [result.data.buffer]);
    } catch (e) {
        const message = e instanceof Error ? e.message : 'Worker job failed';
        const res: VolumeWorkerResponse = { requestId, type: 'error', message };
        ctx.postMessage(res);
    }
};
