export type ToastKind = 'error' | 'info' | 'success' | 'warning';

export interface ToastItem {
    id: number;
    kind: ToastKind;
    message: string;
}

let nextId = 1;
let items: ToastItem[] = [];
const listeners = new Set<() => void>();

function emit() {
    for (const listener of listeners) listener();
}

export function getToasts(): ToastItem[] {
    return items;
}

export function subscribeToasts(onStoreChange: () => void): () => void {
    listeners.add(onStoreChange);
    return () => {
        listeners.delete(onStoreChange);
    };
}

export function dismissToast(id: number) {
    const next = items.filter((t) => t.id !== id);
    if (next.length === items.length) return;
    items = next;
    emit();
}

/** Non-blocking replacement for `alert()`. Defaults to error. */
export function toast(message: string, kind: ToastKind = 'error') {
    const id = nextId++;
    items = [...items, { id, kind, message }].slice(-6);
    emit();
    const ms = kind === 'error' ? 7000 : 4500;
    window.setTimeout(() => dismissToast(id), ms);
}
