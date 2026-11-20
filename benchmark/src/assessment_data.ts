import { AssessmentFraction, _rational, grade_assessment_fields, type AssessmentGrade, type AssessmentTask } from './assessment_tasks.ts';

/** Serializable exact-field grading descriptor shared by every data-defined bank. */
export const ASSESSMENT_DATA_TASK_FORMAT = 'assessment-exact-fields-v1';
type DataObject = Record<string, unknown>;
const object = (value: unknown): value is DataObject => value !== null && typeof value === 'object' && !Array.isArray(value);
function requireData(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error('Assessment data task ' + reason); }

/** Compile tagged fractions and aliases without exposing runtime objects in task snapshots. */
export function assessment_data_expected(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(assessment_data_expected);
    if (object(value)) {
        if (Object.keys(value).length === 1 && typeof value.$fraction === 'string') {
            const fraction = _rational(value.$fraction);
            requireData(fraction instanceof AssessmentFraction, 'has an invalid exact fraction');
            return fraction;
        }
        if (Object.keys(value).length === 1 && Array.isArray(value.$aliases)) {
            requireData(value.$aliases.length > 0 && value.$aliases.every(alias => typeof alias === 'string' && alias.length > 0), 'aliases must be nonempty strings');
            return new Set(value.$aliases);
        }
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, assessment_data_expected(child)]));
    }
    requireData(value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)), 'expected values must be finite JSON data');
    return value;
}

/** Build a runnable card from question JSON and a version-independent grading descriptor. */
export function build_assessment_data_task(value: unknown, grading: unknown): AssessmentTask {
    requireData(object(value), 'must be an object');
    for (const key of ['id', 'title', 'domain', 'kind', 'prompt', 'version']) requireData(typeof value[key] === 'string' && (value[key] as string).trim(), key + ' must be a nonempty string');
    requireData(object(grading) && typeof grading.type === 'string' && typeof grading.name === 'string', 'requires a named grading descriptor');
    const card = structuredClone(value) as AssessmentTask;
    requireData(grading.type === ASSESSMENT_DATA_TASK_FORMAT, 'has an unsupported grading type or descriptor fields');
    const descriptor = grading as DataObject & { expected: Record<string, unknown> };
    requireData(Object.keys(descriptor).length === 3 && descriptor.name === 'grade' && card.kind === 'text' && object(descriptor.expected) && Object.keys(descriptor.expected).length > 0, 'exact-fields grading requires the grade name, a text task and nonempty expected fields');
    const expected = assessment_data_expected(descriptor.expected) as Record<string, unknown>;
    card.grading = structuredClone(descriptor);
    card.grade = (text: unknown): AssessmentGrade => grade_assessment_fields(text, expected);
    return card;
}
