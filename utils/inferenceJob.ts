import { parseNiftiFile } from './niftiUtils';
import { volumeGeometryJson } from './volumeGeometry';
import type { VolumeData } from '../types';

export class InferenceCancelled extends Error {
    constructor() {
        super('Inference cancelled');
        this.name = 'InferenceCancelled';
    }
}

export class InferenceTimeout extends Error {
    constructor(ms: number) {
        super(`Inference timed out after ${Math.round(ms / 1000)}s`);
        this.name = 'InferenceTimeout';
    }
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS = 600;

type JobStatus = 'queued' | 'running' | 'complete' | 'completed' | 'error' | 'failed' | 'cancelled';

interface JobState {
    job_id?: string;
    id?: string;
    status?: JobStatus | string;
    progress?: number;
    error?: string;
    detail?: string;
    result_url?: string;
}

export interface InferenceRunOptions {
    baseUrl: string;
    volume: VolumeData;
    modelId: string;
    timeoutMs?: number;
    onProgress?: (pct: number, label?: string) => void;
}

let activeAbort: AbortController | null = null;
let activeJobUrl: string | null = null;
let abortReason: 'user' | 'timeout' | null = null;

export function cancelInferenceJob() {
    abortReason = 'user';
    activeAbort?.abort();
    const jobUrl = activeJobUrl;
    activeAbort = null;
    activeJobUrl = null;
    if (jobUrl) {
        void fetch(jobUrl, { method: 'DELETE' }).catch(() => undefined);
    }
}

function jobIdOf(state: JobState): string | null {
    const id = state.job_id || state.id;
    return id ? String(id) : null;
}

async function readJob(url: string, signal: AbortSignal): Promise<JobState> {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Job status ${res.status}`);
    return (await res.json()) as JobState;
}

async function niftiFromResponse(res: Response): Promise<VolumeData> {
    const buf = await res.arrayBuffer();
    const vol = parseNiftiFile(buf);
    if (!vol) throw new Error('Failed to parse response as NIfTI');
    return vol;
}

function formFor(volume: VolumeData, modelId: string): FormData {
    const copy = volume.data instanceof Float32Array
        ? new Float32Array(volume.data)
        : Float32Array.from(volume.data as ArrayLike<number>);
    const form = new FormData();
    form.append('file', new Blob([copy], { type: 'application/octet-stream' }), 'volume.raw');
    form.append('dimensions', JSON.stringify(volume.dimensions));
    form.append('model_id', modelId);
    form.append('geometry', volumeGeometryJson(volume));
    return form;
}

async function runAsyncJob(
    base: string,
    volume: VolumeData,
    modelId: string,
    timeoutMs: number,
    onProgress: InferenceRunOptions['onProgress'],
    signal: AbortSignal
): Promise<VolumeData | 'fallback'> {
    const create = await fetch(`${base}/jobs`, { method: 'POST', body: formFor(volume, modelId), signal });
    if (create.status === 404 || create.status === 405) return 'fallback';
    if (!create.ok) throw new Error(`POST /jobs returned ${create.status}: ${create.statusText}`);

    const created = (await create.json()) as JobState;
    const id = jobIdOf(created);
    if (!id) return 'fallback';
    const jobUrl = `${base}/jobs/${encodeURIComponent(id)}`;
    activeJobUrl = jobUrl;
    onProgress?.(Math.max(0, Number(created.progress) || 0), created.status || 'queued');

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (signal.aborted) throw new InferenceCancelled();
        await new Promise((r) => setTimeout(r, POLL_MS));
        const state = await readJob(jobUrl, signal);
        const pct = Number(state.progress);
        if (Number.isFinite(pct)) onProgress?.(Math.max(0, Math.min(100, pct)), String(state.status || 'running'));
        const status = String(state.status || '').toLowerCase();
        if (status === 'complete' || status === 'completed' || status === 'success') {
            const resultUrl = state.result_url
                ? (state.result_url.startsWith('http') ? state.result_url : `${base}${state.result_url}`)
                : `${jobUrl}/result`;
            const res = await fetch(resultUrl, { signal });
            if (!res.ok) throw new Error(`Job result ${res.status}`);
            onProgress?.(100, 'complete');
            return niftiFromResponse(res);
        }
        if (status === 'error' || status === 'failed') {
            throw new Error(state.error || state.detail || 'Inference job failed');
        }
        if (status === 'cancelled' || status === 'canceled') throw new InferenceCancelled();
    }
    throw new InferenceTimeout(timeoutMs);
}

async function runSyncPredict(
    base: string,
    volume: VolumeData,
    modelId: string,
    timeoutMs: number,
    onProgress: InferenceRunOptions['onProgress'],
    signal: AbortSignal
): Promise<VolumeData> {
    onProgress?.(0, 'uploading');
    const res = await fetch(`${base}/predict`, { method: 'POST', body: formFor(volume, modelId), signal });
    if (!res.ok) throw new Error(`POST /predict returned ${res.status}: ${res.statusText}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (!res.body || !len) {
        onProgress?.(100, 'complete');
        return niftiFromResponse(res);
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            chunks.push(value);
            received += value.byteLength;
            onProgress?.(Math.min(99, Math.round((received / len) * 100)), 'downloading');
        }
    }
    const out = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
    }
    onProgress?.(100, 'complete');
    const vol = parseNiftiFile(out.buffer);
    if (!vol) throw new Error('Failed to parse response as NIfTI');
    return vol;
}

/** BACKEND_SPEC.md §12: POST /jobs + GET /jobs/{id}, else POST /predict. Progress is server-reported or download %. */
export async function runInferenceJob(options: InferenceRunOptions): Promise<VolumeData> {
    cancelInferenceJob();
    abortReason = null;
    const base = options.baseUrl.replace(/\/$/, '');
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const ac = new AbortController();
    activeAbort = ac;
    const timer = window.setTimeout(() => {
        abortReason = abortReason ?? 'timeout';
        ac.abort();
    }, timeoutMs);

    try {
        const asyncResult = await runAsyncJob(base, options.volume, options.modelId, timeoutMs, options.onProgress, ac.signal);
        if (asyncResult !== 'fallback') return asyncResult;
        return await runSyncPredict(base, options.volume, options.modelId, timeoutMs, options.onProgress, ac.signal);
    } catch (e) {
        if (e instanceof InferenceCancelled || e instanceof InferenceTimeout) throw e;
        const aborted = ac.signal.aborted || (e instanceof DOMException && e.name === 'AbortError');
        if (aborted) {
            if (abortReason === 'user') throw new InferenceCancelled();
            throw new InferenceTimeout(timeoutMs);
        }
        throw e;
    } finally {
        window.clearTimeout(timer);
        if (activeAbort === ac) {
            activeAbort = null;
            activeJobUrl = null;
        }
    }
}
