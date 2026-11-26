import React, { useSyncExternalStore } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { dismissToast, getToasts, subscribeToasts, type ToastKind } from '../utils/toasts';

const KIND: Record<ToastKind, { icon: typeof Info; border: string; iconClass: string }> = {
    error: { icon: XCircle, border: 'border-red-800/80', iconClass: 'text-red-400' },
    warning: { icon: AlertTriangle, border: 'border-amber-800/80', iconClass: 'text-amber-400' },
    info: { icon: Info, border: 'border-cyan-800/80', iconClass: 'text-cyan-400' },
    success: { icon: CheckCircle2, border: 'border-emerald-800/80', iconClass: 'text-emerald-400' }
};

export const ToastHost: React.FC = () => {
    const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
    if (toasts.length === 0) return null;

    return (
        <div className="pointer-events-none fixed bottom-8 right-4 z-[70] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col-reverse gap-2">
            {toasts.map((t) => {
                const meta = KIND[t.kind];
                const Icon = meta.icon;
                return (
                    <div
                        key={t.id}
                        className={`pointer-events-auto flex items-start gap-2 rounded-lg border bg-gray-900/95 px-3 py-2.5 shadow-xl backdrop-blur-sm ${meta.border}`}
                        role="status"
                    >
                        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${meta.iconClass}`} />
                        <p className="flex-1 text-xs leading-snug text-gray-200">{t.message}</p>
                        <button
                            type="button"
                            onClick={() => dismissToast(t.id)}
                            className="shrink-0 text-gray-500 hover:text-gray-300"
                            aria-label="Dismiss"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                );
            })}
        </div>
    );
};
