/** Row-major 4x4: index = row * 4 + col. Maps column vector [x,y,z,1]^T = M * [i,j,k,1]^T (voxel indices i,j,k). */

export function multiplyMat4(a: number[], b: number[]): number[] {
    const out = new Array<number>(16);
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            out[r * 4 + c] =
                a[r * 4 + 0] * b[0 * 4 + c] +
                a[r * 4 + 1] * b[1 * 4 + c] +
                a[r * 4 + 2] * b[2 * 4 + c] +
                a[r * 4 + 3] * b[3 * 4 + c];
        }
    }
    return out;
}

/** Returns inverse or null if singular. Row-major 4x4. */
export function invertMat4RowMajor(m: number[]): number[] | null {
    const a = m.map((v) => v);
    const inv = new Array<number>(16);
    for (let i = 0; i < 16; i++) inv[i] = i % 5 === 0 ? 1 : 0;

    const swapRows = (r1: number, r2: number) => {
        for (let c = 0; c < 4; c++) {
            const t = a[r1 * 4 + c];
            a[r1 * 4 + c] = a[r2 * 4 + c];
            a[r2 * 4 + c] = t;
        }
        for (let c = 0; c < 4; c++) {
            const t = inv[r1 * 4 + c];
            inv[r1 * 4 + c] = inv[r2 * 4 + c];
            inv[r2 * 4 + c] = t;
        }
    };

    for (let col = 0; col < 4; col++) {
        let pivot = col;
        let maxAbs = Math.abs(a[col * 4 + col]);
        for (let r = col + 1; r < 4; r++) {
            const v = Math.abs(a[r * 4 + col]);
            if (v > maxAbs) {
                maxAbs = v;
                pivot = r;
            }
        }
        if (maxAbs < 1e-12) return null;
        if (pivot !== col) swapRows(pivot, col);

        const piv = a[col * 4 + col];
        const invPiv = 1 / piv;
        for (let c = 0; c < 4; c++) {
            a[col * 4 + c] *= invPiv;
            inv[col * 4 + c] *= invPiv;
        }
        for (let r = 0; r < 4; r++) {
            if (r === col) continue;
            const f = a[r * 4 + col];
            if (Math.abs(f) < 1e-15) continue;
            for (let c = 0; c < 4; c++) {
                a[r * 4 + c] -= f * a[col * 4 + c];
                inv[r * 4 + c] -= f * inv[col * 4 + c];
            }
        }
    }
    return inv;
}

/** Homogeneous point (column): [x,y,z,1] — multiply by inverse affine to get voxel indices. */
export function transformPoint(m: number[], x: number, y: number, z: number): [number, number, number] {
    const w = m[12] * x + m[13] * y + m[14] * z + m[15];
    const iw = Math.abs(w) > 1e-12 ? 1 / w : 1;
    return [
        (m[0] * x + m[1] * y + m[2] * z + m[3]) * iw,
        (m[4] * x + m[5] * y + m[6] * z + m[7]) * iw,
        (m[8] * x + m[9] * y + m[10] * z + m[11]) * iw
    ];
}

/** Voxel center (i+0.5, j+0.5, k+0.5) in patient mm. */
export function voxelCenterToPatientRowMajor(affine: number[], i: number, j: number, k: number): [number, number, number] {
    const ci = i + 0.5;
    const cj = j + 0.5;
    const ck = k + 0.5;
    return [
        affine[0] * ci + affine[1] * cj + affine[2] * ck + affine[3],
        affine[4] * ci + affine[5] * cj + affine[6] * ck + affine[7],
        affine[8] * ci + affine[9] * cj + affine[10] * ck + affine[11]
    ];
}

export function flattenAffineFromNiftiMat(affine: number[][]): number[] {
    const out = new Array<number>(16);
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            out[r * 4 + c] = affine[r][c];
        }
    }
    return out;
}

export function maxAbsDiffMat4(a: number[], b: number[]): number {
    let m = 0;
    for (let i = 0; i < 12; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d > m) m = d;
    }
    return m;
}
