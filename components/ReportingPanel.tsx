import React, { useEffect, useRef, useState } from 'react';
import { FileText, Download, FileJson, Loader2, Sparkles, KeyRound } from 'lucide-react';
import { jsPDF } from 'jspdf';
import { VolumeData, SegmentationStats, ReportImages } from '../types';
import { generateRadiologyReport, hasGeminiApiKey, RadiologyReportContext } from '../services/geminiService';
import { computeSegmentationStats } from '../utils/segmentationStats';
import { jpegDataUrlSize } from '../utils/reportImages';
import { voxelSpacingMm } from '../utils/volumeMetadata';

interface ReportingPanelProps {
    volume: VolumeData | null;
    segmentation: VolumeData | null;
    onGenerateReport?: () => Promise<ReportImages | undefined>;
    onOpenSettings?: () => void;
}

function examContextFromVolume(volume: VolumeData): RadiologyReportContext {
    return {
        modality: volume.metadata?.modality,
        dimensions: volume.dimensions,
        spacingMm: voxelSpacingMm(volume),
        coordSystem: volume.coordSystem ?? volume.metadata?.coordSystem
    };
}

export const ReportingPanel: React.FC<ReportingPanelProps> = ({
    volume,
    segmentation,
    onGenerateReport,
    onOpenSettings
}) => {
    const [stats, setStats] = useState<SegmentationStats[]>([]);
    const [labelMapping, setLabelMapping] = useState<Record<string, string>>({});
    const [findings, setFindings] = useState('');
    const [hasKey, setHasKey] = useState<boolean | null>(null);
    const [aiBusy, setAiBusy] = useState(false);
    const [exporting, setExporting] = useState(false);
    const jsonInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        let cancelled = false;
        void hasGeminiApiKey().then((ok) => {
            if (!cancelled) setHasKey(ok);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!volume || !segmentation) {
            setStats([]);
            return;
        }
        const timer = setTimeout(() => {
            setStats(computeSegmentationStats(volume, segmentation, labelMapping));
        }, 100);
        return () => clearTimeout(timer);
    }, [volume, segmentation, labelMapping]);

    const handleJsonUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const mapping = JSON.parse(await file.text());
            if (mapping && typeof mapping === 'object') setLabelMapping(mapping);
            else alert('Invalid JSON format. Expected key-value pairs.');
        } catch {
            alert('Failed to parse JSON.');
        }
        if (jsonInputRef.current) jsonInputRef.current.value = '';
    };

    const handleGenerate = async () => {
        if (!volume || stats.length === 0) {
            alert('Compute segmentation statistics before generating findings.');
            return;
        }
        setAiBusy(true);
        try {
            const text = await generateRadiologyReport(stats, examContextFromVolume(volume));
            setFindings(text.trim());
            setHasKey(await hasGeminiApiKey());
        } catch (err) {
            console.error(err);
            alert('Failed to generate findings.');
        } finally {
            setAiBusy(false);
        }
    };

    const addFittedJpeg = async (
        doc: jsPDF,
        dataUrl: string,
        x: number,
        y: number,
        boxW: number,
        boxH: number
    ) => {
        const { w, h } = await jpegDataUrlSize(dataUrl);
        const scale = Math.min(boxW / Math.max(1, w), boxH / Math.max(1, h));
        doc.addImage(
            dataUrl,
            'JPEG',
            x + (boxW - w * scale) / 2,
            y + (boxH - h * scale) / 2,
            w * scale,
            h * scale
        );
    };

    const handleExportPdf = async () => {
        if (!volume || !window.electron) {
            alert('Report export requires a loaded scan in the desktop app.');
            return;
        }
        if (!findings.trim()) {
            alert('Generate or type findings before exporting.');
            return;
        }
        setExporting(true);
        try {
            const images = await onGenerateReport?.();
            const doc = new jsPDF();
            const pageWidth = doc.internal.pageSize.getWidth();
            const pageHeight = doc.internal.pageSize.getHeight();
            const margin = 15;
            const paint = () => {
                doc.setFillColor(15, 23, 42);
                doc.rect(0, 0, pageWidth, pageHeight, 'F');
            };
            paint();
            doc.setTextColor(255, 255, 255);
            doc.setFontSize(20);
            doc.text('NeuroScan AI — Radiology Draft', margin, 22);
            doc.setFontSize(9);
            doc.setTextColor(148, 163, 184);
            doc.text(`Exported ${new Date().toLocaleString()}  ·  De-identified (no patient name or ID)`, margin, 30);
            const exam = examContextFromVolume(volume);
            const [dx, dy, dz] = exam.dimensions;
            const [sx, sy, sz] = exam.spacingMm;
            doc.text(
                `${exam.modality || 'MR'}  ·  ${dx}×${dy}×${dz}  ·  ${sx.toFixed(2)}×${sy.toFixed(2)}×${sz.toFixed(2)} mm`,
                margin,
                36
            );
            doc.setDrawColor(51, 65, 85);
            doc.line(margin, 42, pageWidth - margin, 42);

            doc.setFontSize(12);
            doc.setTextColor(34, 211, 238);
            doc.text('Findings', margin, 52);
            doc.setFontSize(10);
            doc.setTextColor(226, 232, 240);
            const lines: string[] = doc.splitTextToSize(findings.trim(), pageWidth - margin * 2);
            let y = 60;
            for (const line of lines) {
                if (y > pageHeight - 18) {
                    doc.addPage();
                    paint();
                    y = 20;
                }
                doc.text(line, margin, y);
                y += 5;
            }

            if (stats.length > 0) {
                if (y > pageHeight - 40) {
                    doc.addPage();
                    paint();
                    y = 20;
                }
                y += 8;
                doc.setFontSize(12);
                doc.setTextColor(34, 211, 238);
                doc.text('Volumetry', margin, y);
                y += 8;
                doc.setFontSize(9);
                for (const s of stats) {
                    if (y > pageHeight - 16) {
                        doc.addPage();
                        paint();
                        y = 20;
                    }
                    doc.setTextColor(226, 232, 240);
                    doc.text(
                        `${s.label}: ${s.volume.toFixed(2)} cm³   mean ${s.intensityMean.toFixed(1)}   SD ${s.intensityStd.toFixed(1)}`,
                        margin,
                        y
                    );
                    y += 6;
                }
            }

            const tiles = [
                { title: 'Axial', src: images?.axial[0] },
                { title: 'Coronal', src: images?.coronal[0] },
                { title: 'Sagittal', src: images?.sagittal[0] },
                { title: '3D', src: images?.threeD[0] }
            ];
            if (tiles.some((t) => t.src)) {
                doc.addPage();
                paint();
                doc.setFontSize(14);
                doc.setTextColor(34, 211, 238);
                doc.text('MPR Snapshots', margin, 18);
                const gap = 8;
                const cellW = (pageWidth - margin * 2 - gap) / 2;
                const cellH = (pageHeight - 36 - gap) / 2;
                for (let i = 0; i < 4; i++) {
                    const col = i % 2;
                    const row = Math.floor(i / 2);
                    const x = margin + col * (cellW + gap);
                    const ty = 24 + row * (cellH + gap);
                    doc.setDrawColor(51, 65, 85);
                    doc.rect(x, ty, cellW, cellH);
                    doc.setFontSize(9);
                    doc.setTextColor(34, 211, 238);
                    doc.text(tiles[i].title, x + 3, ty + 8);
                    if (tiles[i].src) {
                        await addFittedJpeg(doc, tiles[i].src!, x + 4, ty + 12, cellW - 8, cellH - 16);
                    }
                }
            }

            const output = doc.output('arraybuffer');
            await window.electron.saveFile(output, `radiology_draft_${Date.now()}.pdf`, [
                { name: 'PDF Files', extensions: ['pdf'] }
            ]);
        } catch (err) {
            console.error(err);
            alert('Error exporting radiology draft PDF.');
        } finally {
            setExporting(false);
        }
    };

    if (!segmentation) {
        return (
            <div className="h-full flex flex-col items-center justify-center p-6 text-center text-gray-500">
                <FileText className="w-12 h-12 mb-4 opacity-20" />
                <p>AI reporting needs a segmentation.</p>
                <p className="text-xs mt-2">Load or create a mask, then generate an editable findings draft from the computed volumes.</p>
            </div>
        );
    }

    const busy = aiBusy || exporting;

    return (
        <div className="h-full flex flex-col p-4 gap-4 overflow-y-auto">
            <div>
                <div className="flex justify-between items-end mb-2">
                    <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wider">Computed volumetry</h3>
                    <button
                        type="button"
                        onClick={() => jsonInputRef.current?.click()}
                        className="text-[10px] flex items-center gap-1 text-cyan-400 hover:text-cyan-300 transition-colors"
                        title="Import JSON label mapping ({ '1': 'Hippocampus' })"
                    >
                        <FileJson className="w-3 h-3" /> Map Labels
                    </button>
                    <input type="file" ref={jsonInputRef} onChange={handleJsonUpload} accept=".json" className="hidden" />
                </div>
                <div className="bg-gray-800 rounded-lg overflow-hidden border border-gray-700 max-h-36 overflow-y-auto">
                    <table className="w-full text-[11px] text-left">
                        <thead className="bg-gray-900 text-gray-400 sticky top-0">
                            <tr>
                                <th className="p-1.5 pl-3">Region</th>
                                <th className="p-1.5">cm³</th>
                                <th className="p-1.5">Mean</th>
                            </tr>
                        </thead>
                        <tbody className="text-gray-300">
                            {stats.length === 0 && (
                                <tr>
                                    <td colSpan={3} className="p-3 text-center text-gray-600">
                                        No labeled voxels
                                    </td>
                                </tr>
                            )}
                            {stats.map((s) => (
                                <tr key={s.label} className="border-t border-gray-700">
                                    <td className="p-1.5 pl-3 text-cyan-100">{s.label}</td>
                                    <td className="p-1.5 font-mono text-cyan-400">{s.volume.toFixed(2)}</td>
                                    <td className="p-1.5 text-gray-400">{s.intensityMean.toFixed(1)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            <div className="flex flex-col gap-2 min-h-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wider">Findings draft</h3>
                    {hasKey === false && (
                        <button
                            type="button"
                            onClick={onOpenSettings}
                            className="text-[10px] flex items-center gap-1 text-amber-400 hover:text-amber-300"
                        >
                            <KeyRound className="w-3 h-3" /> Add API key
                        </button>
                    )}
                </div>
                <textarea
                    value={findings}
                    onChange={(e) => setFindings(e.target.value)}
                    disabled={aiBusy}
                    placeholder="Generate a draft from the volumes above, then edit. Patient name and ID are never sent to Gemini."
                    className="flex-1 min-h-[180px] w-full resize-y rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-200 leading-relaxed placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-cyan-700 select-text"
                />
                <p className="text-[10px] text-gray-500 leading-snug">
                    Decision-support draft only. The model receives volumes, intensities, matrix, and spacing — not name, ID, DOB, or accession.
                </p>
            </div>

            <div className="space-y-2 shrink-0">
                <button
                    type="button"
                    onClick={handleGenerate}
                    disabled={busy || !volume || stats.length === 0}
                    className="w-full py-3 bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg flex items-center justify-center gap-2 transition-all"
                >
                    {aiBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                    {aiBusy ? 'Generating…' : hasKey === false ? 'Simulate findings draft' : 'Generate findings'}
                </button>
                <button
                    type="button"
                    onClick={handleExportPdf}
                    disabled={busy || !findings.trim()}
                    className="w-full py-3 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg flex items-center justify-center gap-2 transition-all"
                >
                    {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    {exporting ? 'Exporting…' : 'Export draft PDF'}
                </button>
            </div>
        </div>
    );
};
