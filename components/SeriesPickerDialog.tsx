import React from 'react';
import type { DicomSeriesChoice } from '../utils/dicomUtils';

interface SeriesPickerDialogProps {
    series: DicomSeriesChoice[];
    onPick: (uid: string) => void;
    onCancel: () => void;
}

export const SeriesPickerDialog: React.FC<SeriesPickerDialogProps> = ({ series, onPick, onCancel }) => {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
            <div className="w-[28rem] max-h-[80vh] flex flex-col rounded-lg border border-gray-700 bg-gray-900 shadow-2xl">
                <div className="px-4 py-3 border-b border-gray-800">
                    <h2 className="text-sm font-semibold text-gray-100">Select DICOM series</h2>
                    <p className="text-[11px] text-gray-500 mt-1">
                        This folder has {series.length} series. Pick one to load as a volume.
                    </p>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    {series.map((s) => (
                        <button
                            key={s.uid}
                            type="button"
                            onClick={() => onPick(s.uid)}
                            className="w-full text-left px-3 py-2 rounded border border-gray-800 hover:border-cyan-700 hover:bg-gray-800"
                        >
                            <div className="text-xs text-cyan-200">{s.label}</div>
                            <div className="text-[10px] text-gray-500 font-mono truncate" title={s.uid}>
                                {s.rows && s.cols ? `${s.cols}×${s.rows}  ` : ''}{s.uid}
                            </div>
                        </button>
                    ))}
                </div>
                <div className="px-4 py-3 border-t border-gray-800 flex justify-end">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="text-xs px-3 py-1.5 rounded border border-gray-700 text-gray-300 hover:bg-gray-800"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
};
