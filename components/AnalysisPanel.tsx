import React, { useState, useEffect, useRef } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { FileText, Download, Presentation, FileJson, Table2 } from 'lucide-react';
import { VolumeData, SegmentationStats, ReportImages } from '../types';
import { jsPDF } from "jspdf";
import html2canvas from "html2canvas";
import { jpegDataUrlSize } from '../utils/reportImages';
import { ensureVolumeMetadata, voxelSpacingMm } from '../utils/volumeMetadata';
import { computeSegmentationStats } from '../utils/segmentationStats';
import { computeTissueContrast, computeVolumeIntensityStats, TissueContrast, VolumeIntensityStats } from '../utils/volumeStats';
import { csvPhiHeader, reportPatientLine } from '../utils/reportPhi';
import { toast } from '../utils/toasts';

let lastHandledExportId = 0;

interface AnalysisPanelProps {
    volume: VolumeData | null;
    segmentation: VolumeData | null;
    onGenerateReport?: () => Promise<ReportImages | undefined>;
    /** Increment to run Clinical Summary export (File > Export Report). */
    exportRequestId?: number;
    anonymize?: boolean;
    onAnonymizeChange?: (value: boolean) => void;
}

export const AnalysisPanel: React.FC<AnalysisPanelProps> = ({
    volume, segmentation, onGenerateReport, exportRequestId = 0, anonymize = true, onAnonymizeChange
}) => {
    const [generating, setGenerating] = useState(false);
    const [stats, setStats] = useState<SegmentationStats[]>([]);
    const [volumeStats, setVolumeStats] = useState<VolumeIntensityStats | null>(null);
    const [tissue, setTissue] = useState<TissueContrast | null>(null);
    const statsRef = useRef<SegmentationStats[]>([]);
    statsRef.current = stats;
    const volumeStatsRef = useRef<VolumeIntensityStats | null>(null);
    volumeStatsRef.current = volumeStats;
    const tissueRef = useRef<TissueContrast | null>(null);
    tissueRef.current = tissue;
    const [labelMapping, setLabelMapping] = useState<Record<string, string>>({});
    const jsonInputRef = useRef<HTMLInputElement>(null);
    const chartRef = useRef<HTMLDivElement>(null);

    const sanitizeFileName = (name: string): string => {
        return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    };

    const toCsv = () => {
        const meta = volume ? ensureVolumeMetadata(volume) : null;
        const lines = [csvPhiHeader(meta, anonymize), 'scope,label,volume_cm3,intensity_mean,intensity_std'];
        const vs = volumeStats;
        if (vs) {
            lines.push(['volume', 'all_voxels', vs.volumeCm3.toFixed(4), vs.mean.toFixed(4), vs.std.toFixed(4)].join(','));
            lines.push(['volume', 'foreground', vs.foregroundCm3.toFixed(4), '', ''].join(','));
        }
        const tc = tissue;
        if (tc?.snrWm != null) lines.push(`qc,SNR_WM,,${tc.snrWm.toFixed(4)},`);
        if (tc?.snrGm != null) lines.push(`qc,SNR_GM,,${tc.snrGm.toFixed(4)},`);
        if (tc?.cnr != null) lines.push(`qc,CNR_WM_GM,,${tc.cnr.toFixed(4)},`);
        for (const s of stats) {
            lines.push([
                'region',
                `"${String(s.label).replace(/"/g, '""')}"`,
                s.volume.toFixed(4),
                s.intensityMean.toFixed(4),
                s.intensityStd.toFixed(4)
            ].join(','));
        }
        return lines.join('\n');
    };

    const getChartImage = async () => {
        if (!chartRef.current) return '';
        const canvas = await html2canvas(chartRef.current, { backgroundColor: '#111827' });
        return canvas.toDataURL('image/png');
    };

    const paintPage = (doc: jsPDF) => {
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        doc.setFillColor(15, 23, 42);
        doc.rect(0, 0, pageWidth, pageHeight, 'F');
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
        const dw = w * scale;
        const dh = h * scale;
        doc.addImage(dataUrl, 'JPEG', x + (boxW - dw) / 2, y + (boxH - dh) / 2, dw, dh);
    };

    const buildClinicalSummaryPdf = async (images?: ReportImages) => {
        const chartImgData = await getChartImage();
        const doc = new jsPDF();
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const margin = 15;
        const meta = volume ? ensureVolumeMetadata(volume) : null;
        const spacing = volume ? (meta?.spacingMm ?? voxelSpacingMm(volume)) : [1, 1, 1];

        paintPage(doc);
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(22);
        doc.text("NeuroScan AI - Clinical Summary", margin, 20);

        doc.setFontSize(10);
        doc.setTextColor(148, 163, 184);
        doc.text(`Date: ${new Date().toLocaleDateString()}`, margin, 30);
        if (meta) {
            doc.text(reportPatientLine(meta, anonymize), margin, 36);
            const studyBits = [meta.modality, meta.studyDate, meta.seriesDescription || meta.studyDescription]
                .filter(Boolean)
                .join(' · ');
            if (studyBits) doc.text(studyBits, margin, 42);
            if (volume) {
                const [dx, dy, dz] = volume.dimensions;
                doc.text(
                    `Matrix ${dx}×${dy}×${dz}  |  Spacing ${spacing[0].toFixed(2)}×${spacing[1].toFixed(2)}×${spacing[2].toFixed(2)} mm`,
                    margin,
                    48
                );
            }
        }
        doc.line(margin, 52, pageWidth - margin, 52);

        let yPos = 60;
        if (chartImgData) {
            doc.addImage(chartImgData, 'PNG', margin, yPos, pageWidth - margin * 2, 70);
            yPos += 80;
        }

        const vs = volumeStatsRef.current;
        if (vs) {
            doc.setFontSize(12);
            doc.setTextColor(34, 211, 238);
            doc.text('Whole-volume intensity', margin, yPos);
            yPos += 8;
            doc.setFontSize(10);
            doc.setTextColor(200, 200, 200);
            doc.text(
                `Mean ${vs.mean.toFixed(1)}  SD ${vs.std.toFixed(1)}  min ${vs.min.toFixed(1)}  max ${vs.max.toFixed(1)}`,
                margin,
                yPos
            );
            yPos += 6;
            doc.text(
                `P5/P50/P95  ${vs.p5.toFixed(1)} / ${vs.p50.toFixed(1)} / ${vs.p95.toFixed(1)}   FOV ${vs.volumeCm3.toFixed(1)} cm³   FG ${vs.foregroundCm3.toFixed(1)} cm³`,
                margin,
                yPos
            );
            yPos += 10;
        }

        const tc = tissueRef.current;
        if (tc && (tc.snrWm != null || tc.cnr != null)) {
            doc.setFontSize(12);
            doc.setTextColor(34, 211, 238);
            doc.text('Tissue contrast', margin, yPos);
            yPos += 8;
            doc.setFontSize(10);
            doc.setTextColor(200, 200, 200);
            const bits = [
                tc.snrWm != null ? `SNR WM ${tc.snrWm.toFixed(2)}` : null,
                tc.snrGm != null ? `SNR GM ${tc.snrGm.toFixed(2)}` : null,
                tc.cnr != null ? `CNR ${tc.cnr.toFixed(2)}` : null
            ].filter(Boolean);
            doc.text(bits.join('   '), margin, yPos);
            yPos += 10;
        }

        doc.setFontSize(12);
        doc.setTextColor(34, 211, 238);
        doc.text("Region Statistics", margin, yPos);
        yPos += 10;

        const regionStats = statsRef.current;
        if (regionStats.length === 0) {
            doc.setFontSize(10);
            doc.setTextColor(148, 163, 184);
            doc.text(segmentation ? 'No labeled voxels in the current segmentation.' : 'No segmentation loaded.', margin, yPos);
        } else {
            doc.setFontSize(10);
            doc.setTextColor(200, 200, 200);
            doc.setFillColor(30, 41, 59);
            doc.rect(margin, yPos - 5, pageWidth - margin * 2, 8, 'F');
            doc.text("Region", margin + 2, yPos);
            doc.text("Vol (cm³)", margin + 60, yPos);
            doc.text("Mean Int", margin + 100, yPos);
            doc.text("Std Dev", margin + 140, yPos);
            yPos += 10;

            regionStats.forEach((s) => {
                if (yPos > pageHeight - 20) {
                    doc.addPage();
                    paintPage(doc);
                    yPos = 20;
                }
                doc.setTextColor(200, 200, 200);
                doc.text(s.label, margin + 2, yPos);
                doc.text(s.volume.toFixed(2), margin + 60, yPos);
                doc.text(s.intensityMean.toFixed(1), margin + 100, yPos);
                doc.text(s.intensityStd.toFixed(1), margin + 140, yPos);
                yPos += 7;
            });
        }

        if (images) {
            const mprTiles: { title: string; src?: string }[] = [
                { title: 'Axial', src: images.axial[0] },
                { title: 'Coronal', src: images.coronal[0] },
                { title: 'Sagittal', src: images.sagittal[0] },
                { title: '3D', src: images.threeD[0] }
            ];
            if (mprTiles.some((t) => t.src)) {
                doc.addPage();
                paintPage(doc);
                doc.setFontSize(16);
                doc.setTextColor(34, 211, 238);
                doc.text("MPR Snapshots", margin, 18);
                const gap = 8;
                const cellW = (pageWidth - margin * 2 - gap) / 2;
                const cellH = (pageHeight - 36 - gap) / 2;
                for (let i = 0; i < 4; i++) {
                    const col = i % 2;
                    const row = Math.floor(i / 2);
                    const x = margin + col * (cellW + gap);
                    const y = 24 + row * (cellH + gap);
                    doc.setDrawColor(51, 65, 85);
                    doc.rect(x, y, cellW, cellH);
                    doc.setFontSize(9);
                    doc.setTextColor(34, 211, 238);
                    doc.text(mprTiles[i].title, x + 3, y + 8);
                    if (mprTiles[i].src) {
                        await addFittedJpeg(doc, mprTiles[i].src!, x + 4, y + 12, cellW - 8, cellH - 16);
                    } else {
                        doc.setTextColor(100, 116, 139);
                        doc.text("Not available", x + 8, y + cellH / 2);
                    }
                }
            }

            const addImageSection = async (title: string, imgs: string[]) => {
                if (imgs.length === 0) return;
                doc.addPage();
                paintPage(doc);
                doc.setFontSize(16);
                doc.setTextColor(34, 211, 238);
                doc.text(title, margin, 20);

                let x = margin;
                let y = 30;
                const w = (pageWidth - margin * 3) / 2;
                const h = w * 0.85;

                for (const img of imgs) {
                    if (y + h > pageHeight - 10) {
                        doc.addPage();
                        paintPage(doc);
                        y = 30;
                        x = margin;
                    }
                    await addFittedJpeg(doc, img, x, y, w, h);
                    if (x === margin) {
                        x = margin + w + margin;
                    } else {
                        x = margin;
                        y += h + 10;
                    }
                }
            };

            await addImageSection("Axial Slices", images.axial);
            await addImageSection("Coronal Slices", images.coronal);
            await addImageSection("Sagittal Slices", images.sagittal);
        }

        return doc;
    };

    useEffect(() => {
        if (!volume) {
            setVolumeStats(null);
            setTissue(null);
            setStats([]);
            return;
        }
        const timer = setTimeout(() => {
            const vs = computeVolumeIntensityStats(volume);
            setVolumeStats(vs);
            setTissue(computeTissueContrast(volume, segmentation, vs, labelMapping));
            setStats(segmentation ? computeSegmentationStats(volume, segmentation, labelMapping) : []);
        }, 80);
        return () => clearTimeout(timer);
    }, [volume, segmentation, labelMapping]);

    const handleClinicalSummaryExport = async () => {
        if (!onGenerateReport) return;
        if (!volume) {
            toast('Load a scan before exporting a report.', 'warning');
            return;
        }
        if (!window.electron) {
            toast('Report export requires the desktop app.', 'warning');
            return;
        }
        setGenerating(true);

        try {
            if (statsRef.current.length === 0 && !volumeStatsRef.current) {
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
            const images = await onGenerateReport();
            const doc = await buildClinicalSummaryPdf(images);
            const output = doc.output('arraybuffer');
            await window.electron.saveFile(output, `clinical_summary_${Date.now()}.pdf`, [
                { name: 'PDF Files', extensions: ['pdf'] }
            ]);
        } catch (e) {
            console.error(e);
            toast("Error generating clinical summary PDF");
        } finally {
            setGenerating(false);
        }
    };

    const clinicalExportRef = useRef(handleClinicalSummaryExport);
    clinicalExportRef.current = handleClinicalSummaryExport;

    useEffect(() => {
        if (!exportRequestId || exportRequestId === lastHandledExportId) return;
        lastHandledExportId = exportRequestId;
        void clinicalExportRef.current();
    }, [exportRequestId]);

    const handleResearchMetricsExport = async () => {
        if (!volumeStats && stats.length === 0) return;

        try {
            const csv = toCsv();
            const csvBuffer = new TextEncoder().encode(csv).buffer as ArrayBuffer;
            await window.electron.saveFile(csvBuffer, `research_metrics_${Date.now()}.csv`, [
                { name: 'CSV Files', extensions: ['csv'] }
            ]);
        } catch (e) {
            console.error(e);
            toast('Error exporting research metrics CSV');
        }
    };

    const handlePresentationPackExport = async () => {
        if (!volume || !onGenerateReport) return;
        setGenerating(true);

        try {
            const dir = await window.electron.selectDirectory();
            if (!dir) return;

            const timestamp = Date.now();
            const bundleName = sanitizeFileName(`presentation_pack_${timestamp}`);
            const images = await onGenerateReport();
            const chartImage = await getChartImage();
            const csv = toCsv();
            const meta = volume ? ensureVolumeMetadata(volume) : null;
            const readme = [
                'NeuroScan AI Presentation Pack',
                `Generated: ${new Date().toISOString()}`,
                csvPhiHeader(meta, anonymize),
                '',
                'Slice JPEGs do not burn patient name or ID.',
                'Files included:',
                '- metrics/research_metrics.csv',
                '- images/chart.png',
                '- images/axial_*.jpg, coronal_*.jpg, sagittal_*.jpg, 3d_*.jpg'
            ].join('\n');

            const files: Array<{ relativePath: string; content: string; encoding?: 'utf8' | 'base64' }> = [
                { relativePath: `${bundleName}/README.txt`, content: readme, encoding: 'utf8' },
                { relativePath: `${bundleName}/metrics/research_metrics.csv`, content: csv, encoding: 'utf8' }
            ];

            const pushDataUrl = (relativePath: string, dataUrl: string) => {
                const [, base64] = dataUrl.split(',');
                if (!base64) return;
                files.push({ relativePath, content: base64, encoding: 'base64' });
            };

            if (chartImage) {
                pushDataUrl(`${bundleName}/images/chart.png`, chartImage);
            }

            if (images) {
                images.axial.forEach((img, i) => pushDataUrl(`${bundleName}/images/axial_${i + 1}.jpg`, img));
                images.coronal.forEach((img, i) => pushDataUrl(`${bundleName}/images/coronal_${i + 1}.jpg`, img));
                images.sagittal.forEach((img, i) => pushDataUrl(`${bundleName}/images/sagittal_${i + 1}.jpg`, img));
                images.threeD.forEach((img, i) => pushDataUrl(`${bundleName}/images/3d_${i + 1}.jpg`, img));
            }

            const success = await window.electron.writeBundle(dir, files);
            if (!success) {
                throw new Error('Bundle writing failed');
            }
        } catch (e) {
            console.error(e);
            toast('Error exporting presentation pack');
        } finally {
            setGenerating(false);
        }
    };

    const handleJsonUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const text = await file.text();
            const mapping = JSON.parse(text);
            if (typeof mapping === 'object') {
                setLabelMapping(mapping);
            } else {
                toast("Invalid JSON format. Expected key-value pairs.");
            }
        } catch (err) {
            console.error(err);
            toast("Failed to parse JSON.");
        }
        if (jsonInputRef.current) jsonInputRef.current.value = '';
    };

    if (!volume) {
        return (
            <div className="h-full flex flex-col items-center justify-center p-6 text-center text-gray-500">
                <FileText className="w-12 h-12 mb-4 opacity-20" />
                <p>Load a scan to see intensity statistics.</p>
                <p className="text-xs mt-2">A segmentation is optional for SNR/CNR and region volumes.</p>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col p-4 gap-5 overflow-y-auto">
            <label className="flex items-center justify-between gap-2 text-[11px] text-gray-300 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2">
                <span>Anonymize exports (omit name and ID)</span>
                <input
                    type="checkbox"
                    checked={anonymize}
                    onChange={(e) => onAnonymizeChange?.(e.target.checked)}
                    className="accent-cyan-500"
                />
            </label>

            <div>
                <h3 className="text-sm font-semibold text-gray-200 mb-3 uppercase tracking-wider">Intensity histogram</h3>
                {volumeStats ? (
                    <div ref={chartRef} className="h-40 w-full bg-gray-900 rounded-lg p-2 border border-gray-800">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={volumeStats.histogram}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                                <XAxis dataKey="x" fontSize={9} stroke="#9ca3af" tickFormatter={(v: number) => Number(v).toFixed(0)} />
                                <YAxis fontSize={9} stroke="#9ca3af" />
                                <Tooltip
                                    contentStyle={{ backgroundColor: '#1f2937', borderColor: '#374151', color: '#f3f4f6' }}
                                    itemStyle={{ color: '#f3f4f6' }}
                                    formatter={(value: number) => [value.toLocaleString(), 'voxels']}
                                    labelFormatter={(v) => `Intensity ${Number(v).toFixed(1)}`}
                                />
                                <Bar dataKey="count" name="Voxels" fill="#22d3ee" />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                ) : (
                    <div className="h-40 bg-gray-900 rounded-lg flex items-center justify-center text-xs text-gray-600">
                        Computing…
                    </div>
                )}
            </div>

            {volumeStats && (
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <StatChip label="Mean" value={volumeStats.mean.toFixed(1)} />
                    <StatChip label="SD" value={volumeStats.std.toFixed(1)} />
                    <StatChip label="Min / max" value={`${volumeStats.min.toFixed(0)} / ${volumeStats.max.toFixed(0)}`} />
                    <StatChip label="P5 / P50 / P95" value={`${volumeStats.p5.toFixed(0)} / ${volumeStats.p50.toFixed(0)} / ${volumeStats.p95.toFixed(0)}`} />
                    <StatChip label="FOV cm³" value={volumeStats.volumeCm3.toFixed(1)} />
                    <StatChip label="Foreground cm³" value={volumeStats.foregroundCm3.toFixed(1)} />
                </div>
            )}

            {tissue && (tissue.snrWm != null || tissue.cnr != null || tissue.note) && (
                <div className="bg-gray-800 rounded-lg border border-gray-700 p-3 space-y-2">
                    <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wider">SNR / CNR</h3>
                    <div className="grid grid-cols-3 gap-2 text-[11px]">
                        <StatChip label="SNR WM" value={tissue.snrWm != null ? tissue.snrWm.toFixed(2) : '—'} />
                        <StatChip label="SNR GM" value={tissue.snrGm != null ? tissue.snrGm.toFixed(2) : '—'} />
                        <StatChip label="CNR" value={tissue.cnr != null ? tissue.cnr.toFixed(2) : '—'} />
                    </div>
                    <p className="text-[10px] text-gray-500 leading-snug">{tissue.note}</p>
                </div>
            )}

            <div>
                <div className="flex justify-between items-end mb-3">
                    <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wider">Region volumes</h3>
                    <button
                        onClick={() => jsonInputRef.current?.click()}
                        className="text-[10px] flex items-center gap-1 text-cyan-400 hover:text-cyan-300 transition-colors"
                        title="Import JSON Label Mapping ({ '1': 'Hippocampus', '2': 'GM', '3': 'WM' })"
                    >
                        <FileJson className="w-3 h-3" /> Map Labels
                    </button>
                    <input type="file" ref={jsonInputRef} onChange={handleJsonUpload} accept=".json" className="hidden" />
                </div>
                {stats.length > 0 && (
                    <div className="h-36 w-full bg-gray-900 rounded-lg p-2 border border-gray-800 mb-3">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={stats}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                                <XAxis dataKey="label" fontSize={10} stroke="#9ca3af" tickFormatter={(val) => val.substring(0, 10)} />
                                <YAxis fontSize={10} stroke="#9ca3af" />
                                <Tooltip
                                    contentStyle={{ backgroundColor: '#1f2937', borderColor: '#374151', color: '#f3f4f6' }}
                                    itemStyle={{ color: '#f3f4f6' }}
                                    formatter={(value: number) => [value.toFixed(2), '']}
                                />
                                <Bar dataKey="volume" name="Volume (cm³)" fill="#00a3c4">
                                    {stats.map((_, index) => (
                                        <Cell key={`cell-${index}`} fill={['#00a3c4', '#a855f7', '#10b981', '#ef4444', '#f59e0b', '#ec4899'][index % 6]} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                )}
                <div className="bg-gray-800 rounded-lg overflow-hidden border border-gray-700">
                    <div className="overflow-x-auto">
                        <table className="w-full text-xs text-left">
                            <thead className="bg-gray-900 text-gray-400">
                                <tr>
                                    <th className="p-2 pl-3">Region / Label</th>
                                    <th className="p-2">Vol (cm³)</th>
                                    <th className="p-2">Mean Int.</th>
                                    <th className="p-2">Std Dev</th>
                                </tr>
                            </thead>
                            <tbody className="text-gray-300">
                                {stats.length === 0 && (
                                    <tr><td colSpan={4} className="p-4 text-center text-gray-600">{segmentation ? 'No labeled voxels' : 'Load a segmentation for region volumes'}</td></tr>
                                )}
                                {stats.map((s, i) => (
                                    <tr key={i} className="border-t border-gray-700 hover:bg-gray-750/50 transition-colors">
                                        <td className="p-2 pl-3 font-medium text-cyan-100">{s.label}</td>
                                        <td className="p-2 font-mono text-cyan-400">{s.volume.toFixed(2)}</td>
                                        <td className="p-2 text-gray-400">{s.intensityMean.toFixed(1)}</td>
                                        <td className="p-2 text-gray-500">{s.intensityStd.toFixed(1)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <div className="mt-auto space-y-2">
                <button
                    onClick={handleClinicalSummaryExport}
                    disabled={generating || !volume}
                    className="w-full py-3 bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg flex items-center justify-center gap-2 transition-all shadow-lg"
                >
                    <Download className={`w-4 h-4 ${generating ? 'animate-bounce' : ''}`} />
                    {generating ? 'Compiling...' : 'Clinical Summary (PDF)'}
                </button>
                <button
                    onClick={handleResearchMetricsExport}
                    disabled={generating || (!volumeStats && stats.length === 0)}
                    className="w-full py-3 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg flex items-center justify-center gap-2 transition-all shadow-lg"
                >
                    <Table2 className="w-4 h-4" />
                    Research Metrics (CSV)
                </button>
                <button
                    onClick={handlePresentationPackExport}
                    disabled={generating || !volume}
                    className="w-full py-3 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg flex items-center justify-center gap-2 transition-all shadow-lg"
                >
                    <Presentation className="w-4 h-4" />
                    {generating ? 'Bundling Files...' : 'Presentation Pack (Bundle)'}
                </button>
            </div>
        </div>
    );
};

function StatChip({ label, value }: { label: string; value: string }) {
    return (
        <div className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wide text-gray-500">{label}</div>
            <div className="font-mono text-cyan-300">{value}</div>
        </div>
    );
}