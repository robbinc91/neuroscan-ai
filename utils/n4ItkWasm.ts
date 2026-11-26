import type { VolumeData } from '../types';

export interface ItkN4Options {
    meshSpacingMm?: number;
    iterationsPerLevel?: number;
    fwhm?: number;
    wienerNoise?: number;
    convergenceThreshold?: number;
}

export interface ItkN4Result {
    data: Float32Array;
    min: number;
    max: number;
}

/**
 * Optional ITK-WASM N4. There is no published `@itk-wasm/n4-bias-correction` on npm
 * as of this writing; if that pipeline (or a compatible export) is installed locally,
 * we load it dynamically. Otherwise callers fall back to the JS hierarchical N4.
 */
export async function tryItkWasmN4(
    volume: VolumeData,
    options: ItkN4Options,
    onProgress?: (pct: number) => void | Promise<void>
): Promise<ItkN4Result | null> {
    let mod: Record<string, unknown> | null = null;
    try {
        const spec = '@itk-wasm/' + 'n4-bias-correction';
        mod = await import(/* @vite-ignore */ spec) as Record<string, unknown>;
    } catch {
        return null;
    }
    const fn = (mod.n4BiasCorrection || mod.n4BiasFieldCorrection || mod.default) as
        | ((args: unknown) => Promise<unknown>)
        | undefined;
    if (typeof fn !== 'function') return null;

    onProgress?.(5);
    const [nx, ny, nz] = volume.dimensions;
    const image = {
        imageType: {
            dimension: 3,
            componentType: 'float32',
            pixelType: 'Scalar',
            components: 1
        },
        name: 'volume',
        origin: [0, 0, 0],
        spacing: [
            Math.hypot(volume.affine?.[0] ?? 1, volume.affine?.[4] ?? 0, volume.affine?.[8] ?? 0) || 1,
            Math.hypot(volume.affine?.[1] ?? 0, volume.affine?.[5] ?? 1, volume.affine?.[9] ?? 0) || 1,
            Math.hypot(volume.affine?.[2] ?? 0, volume.affine?.[6] ?? 0, volume.affine?.[10] ?? 1) || 1
        ],
        direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        size: [nx, ny, nz],
        data: volume.data instanceof Float32Array ? volume.data : Float32Array.from(volume.data as ArrayLike<number>)
    };

    const result = await fn({
        image,
        meshResolution: [1, 1, 1],
        numberOfIterations: [Math.max(1, Math.round(options.iterationsPerLevel ?? 8))],
        convergenceThreshold: options.convergenceThreshold ?? 0.001,
        biasFieldFullWidthAtHalfMaximum: options.fwhm ?? 0.15,
        wienerFilterNoise: options.wienerNoise ?? 0.01,
        splineDistance: options.meshSpacingMm ?? 50
    });

    const outImage = (result as { outputImage?: { data?: ArrayLike<number> }; image?: { data?: ArrayLike<number> } })
        .outputImage
        || (result as { image?: { data?: ArrayLike<number> } }).image;
    const data = outImage?.data;
    if (!data || data.length !== nx * ny * nz) return null;

    const out = data instanceof Float32Array ? data : Float32Array.from(data);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < out.length; i++) {
        const v = out[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }
    onProgress?.(100);
    return { data: out, min, max };
}
