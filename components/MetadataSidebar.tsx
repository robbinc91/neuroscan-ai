import React, { useMemo, useState } from 'react';
import type { VolumeData } from '../types';
import { ensureVolumeMetadata, voxelSpacingMm } from '../utils/volumeMetadata';

interface MetadataSidebarProps {
    volume: VolumeData | null;
}

function Row({ label, value, always = false }: { label: string; value?: string | number | null; always?: boolean }) {
    if (!always && (value == null || value === '')) return null;
    return (
        <div className="grid grid-cols-[88px_1fr] gap-2 py-1 text-[11px] leading-snug">
            <div className="text-gray-500 uppercase tracking-wide">{label}</div>
            <div className="text-gray-200 font-mono break-all">{value == null || value === '' ? '—' : String(value)}</div>
        </div>
    );
}

export const MetadataSidebar: React.FC<MetadataSidebarProps> = ({ volume }) => {
    const [query, setQuery] = useState('');
    const meta = volume ? ensureVolumeMetadata(volume) : null;
    const tags = meta?.tags ?? [];
    const q = query.trim().toLowerCase();
    const visibleTags = useMemo(() => {
        if (!q) return tags;
        return tags.filter((t) =>
            t.id.toLowerCase().includes(q)
            || t.name.toLowerCase().includes(q)
            || t.value.toLowerCase().includes(q)
        );
    }, [tags, q]);

    if (!volume || !meta) {
        return (
            <div className="h-full flex items-center justify-center p-6 text-center text-xs text-gray-500">
                Load a NIfTI or DICOM scan to inspect header metadata.
            </div>
        );
    }

    const spacing = meta.spacingMm ?? voxelSpacingMm(volume);
    const [dx, dy, dz] = volume.dimensions;
    const fov = [dx * spacing[0], dy * spacing[1], dz * spacing[2]];

    return (
        <div className="h-full overflow-y-auto p-4 space-y-5">
            <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400 mb-2">Patient / Study</h3>
                <Row always label="Name" value={meta.patientName} />
                <Row always label="ID" value={meta.patientId} />
                <Row always label="Sex" value={meta.patientSex} />
                <Row always label="DOB" value={meta.patientBirthDate} />
                <Row always label="Date" value={meta.studyDate} />
                <Row label="Time" value={meta.studyTime} />
                <Row always label="Study" value={meta.studyDescription} />
                <Row always label="Series" value={meta.seriesDescription} />
                <Row always label="Modality" value={meta.modality} />
                <Row label="Accession" value={meta.accessionNumber} />
                <Row label="Institution" value={meta.institution} />
                <Row label="Protocol" value={meta.protocolName} />
                <Row label="Source" value={meta.sourceName || meta.source.toUpperCase()} />
                {meta.source === 'nifti' && !meta.patientId && !meta.patientName && (
                    <div className="text-[10px] text-gray-500 italic">NIfTI has no patient DICOM tags.</div>
                )}
            </section>

            <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400 mb-2">Geometry</h3>
                <Row always label="Matrix" value={`${dx} × ${dy} × ${dz}`} />
                <Row
                    always
                    label="Spacing"
                    value={`${spacing[0].toFixed(2)} × ${spacing[1].toFixed(2)} × ${spacing[2].toFixed(2)} mm`}
                />
                <Row
                    always
                    label="FOV"
                    value={`${fov[0].toFixed(1)} × ${fov[1].toFixed(1)} × ${fov[2].toFixed(1)} mm`}
                />
                <Row always label="Space" value={meta.coordSystem ?? volume.coordSystem} />
                {meta.qformCode != null && <Row label="qform" value={meta.qformCode} />}
                {meta.sformCode != null && <Row label="sform" value={meta.sformCode} />}
                <Row label="Notes" value={meta.geometryNotes} />
            </section>

            <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400 mb-2">Image</h3>
                <Row label="Datatype" value={meta.datatype} />
                <Row always label="Intensity" value={`${volume.min.toFixed(1)} … ${volume.max.toFixed(1)}`} />
                <Row always label="Voxels" value={volume.data.length.toLocaleString()} />
                <Row label="Series UID" value={meta.seriesUid} />
                <Row label="Manufacturer" value={meta.manufacturer} />
                <Row label="Description" value={meta.description} />
            </section>

            {meta.source === 'dicom' && (
                <section>
                    <h3 className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400 mb-2">
                        DICOM tags
                        <span className="ml-2 font-normal text-gray-500">
                            {visibleTags.length}{q ? ` / ${tags.length}` : ''}
                        </span>
                    </h3>
                    <input
                        type="search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Filter tag, name, value"
                        className="mb-2 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-[11px] text-gray-200 outline-none placeholder:text-gray-600 focus:border-cyan-700"
                    />
                    {tags.length === 0 ? (
                        <div className="text-[10px] text-gray-500 italic">No DICOM tags were parsed from this series.</div>
                    ) : (
                        <div className="space-y-1">
                            {visibleTags.map((t) => (
                                <div key={t.id} className="border-b border-gray-800/80 pb-1">
                                    <div className="flex items-baseline justify-between gap-2 font-mono text-[10px]">
                                        <span className="text-cyan-500/90">{t.id}</span>
                                        <span className="truncate text-gray-500">{t.name}{t.vr ? ` · ${t.vr}` : ''}</span>
                                    </div>
                                    <div className="font-mono text-[11px] text-gray-200 break-all">{t.value}</div>
                                </div>
                            ))}
                            {visibleTags.length === 0 && (
                                <div className="text-[10px] text-gray-500 italic">No tags match “{query}”.</div>
                            )}
                        </div>
                    )}
                </section>
            )}
        </div>
    );
};
