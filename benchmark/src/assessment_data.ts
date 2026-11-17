import { ASSESSMENT_TASKS, AssessmentFraction, _rational, grade_assessment_fields, type AssessmentGrade, type AssessmentTask } from './assessment_tasks.ts';
import { ASSESSMENT_RESOURCE_TASK_FORMAT, configure_assessment_resource_task } from './assessment_resource.ts';
import { ASSESSMENT_DFA_TASK_FORMAT, configure_assessment_dfa_task } from './assessment_dfa.ts';

/** Serializable exact-field grading descriptor shared by every data-defined bank. */
export const ASSESSMENT_DATA_TASK_FORMAT = 'assessment-exact-fields-v1';
/** Named grading reuses a fixed built-in oracle without selecting a bank version. */
export const ASSESSMENT_NAMED_TASK_FORMAT = 'assessment-named-v1';
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
    if (grading.type === ASSESSMENT_DFA_TASK_FORMAT) {
        const descriptor = grading as DataObject & { config: Record<string, unknown> };
        requireData(Object.keys(descriptor).length === 3 && descriptor.name === 'identify' && card.kind === 'tool' && object(descriptor.config), 'DFA grading requires the identify name, a tool task and a configuration');
        const dfaTask = configure_assessment_dfa_task(card, descriptor.config);
        dfaTask.grading = structuredClone(descriptor);
        return dfaTask;
    }
    if (grading.type === ASSESSMENT_RESOURCE_TASK_FORMAT) {
        const descriptor = grading as DataObject & { config: Record<string, unknown> };
        requireData(Object.keys(descriptor).length === 3 && descriptor.name === 'simulate' && card.kind === 'tool' && object(descriptor.config), 'resource grading requires the simulate name, a tool task and a configuration');
        const resourceTask = configure_assessment_resource_task(card, descriptor.config);
        resourceTask.grading = structuredClone(descriptor);
        return resourceTask;
    }
    if (grading.type === ASSESSMENT_DATA_TASK_FORMAT) {
        const descriptor = grading as DataObject & { expected: Record<string, unknown> };
        requireData(Object.keys(descriptor).length === 3 && descriptor.name === 'grade' && card.kind === 'text' && object(descriptor.expected) && Object.keys(descriptor.expected).length > 0, 'exact-fields grading requires the grade name, a text task and nonempty expected fields');
        const expected = assessment_data_expected(descriptor.expected) as Record<string, unknown>;
        card.grading = structuredClone(descriptor);
        card.grade = (text: unknown): AssessmentGrade => grade_assessment_fields(text, expected);
        return card;
    }
    requireData(grading.type === ASSESSMENT_NAMED_TASK_FORMAT && Object.keys(grading).length === 2, 'has an unsupported grading type or descriptor fields');
    const named = ASSESSMENT_TASKS.find(task => task.id === grading.name);
    requireData(named !== undefined, 'references an unknown named grader: ' + grading.name);
    card.grade = named.grade;
    if (named.make_simulator) card.make_simulator = () => named.make_simulator!();
    return card;
}
