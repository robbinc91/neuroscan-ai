import type { VolumeMetadata } from '../types';

export function reportPatientLine(meta: VolumeMetadata | null | undefined, anonymize: boolean): string {
    if (anonymize) return 'Patient: de-identified';
    if (!meta) return 'Patient: —';
    const who =
        meta.patientName && meta.patientId ? `${meta.patientName}  ${meta.patientId}`
        : meta.patientId || meta.patientName || null;
    return who ? `Patient: ${who}` : 'Patient: —';
}

export function csvPhiHeader(meta: VolumeMetadata | null | undefined, anonymize: boolean): string {
    if (anonymize) return '# patient: de-identified';
    if (!meta) return '# patient: —';
    const name = (meta.patientName || '').replace(/"/g, '""');
    const id = (meta.patientId || '').replace(/"/g, '""');
    return `# patient_name: ${name}\n# patient_id: ${id}`;
}
