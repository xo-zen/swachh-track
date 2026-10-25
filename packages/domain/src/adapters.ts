import { kgToGrams } from './primitives';

export interface ScaleReading { kg: number; photoId: string; source: 'MANUAL'; provenance: 'SELF_REPORTED' }
export interface ScaleAdapter { read(input: { kg: number; photoId: string }): ScaleReading }
export class ManualScaleAdapter implements ScaleAdapter {
  read(input: { kg: number; photoId: string }): ScaleReading {
    if (kgToGrams(input.kg) === 0 || !input.photoId.trim()) throw new Error('Positive kg and scale proof photo are required');
    return { kg: input.kg, photoId: input.photoId, source: 'MANUAL', provenance: 'SELF_REPORTED' };
  }
}
export interface ContaminationScorer { score(photoId: string): { status: 'NOT_MEASURED'; score: null } }
export class NoopContaminationScorer implements ContaminationScorer {
  score(_photoId: string): { status: 'NOT_MEASURED'; score: null } { return { status: 'NOT_MEASURED', score: null }; }
}
