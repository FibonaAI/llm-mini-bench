import {
    ASSESSMENT_BLACKBOX_V2_TASK_FORMAT,
    BlackboxV2AssessmentSimulator,
    assessment_blackbox_v2_tools
} from './assessment_blackbox_v2.ts';
import {
    ASSESSMENT_DOCUMENTS_V2_TASK_FORMAT,
    DocumentV2AssessmentSimulator,
    assessment_documents_v2_tools
} from './assessment_documents_v2.ts';
import {
    ASSESSMENT_DELEGATED_RELEASE_V2_TASK_FORMAT,
    DelegatedReleaseV2AssessmentSimulator,
    assessment_delegated_release_v2_tools
} from './assessment_delegated_release_v2.ts';
import { assessment_exact_fields, is_assessment_object, type AssessmentTask } from './assessment_tasks.ts';

/** Additional source bytes for the v2 graders, on top of the reused v1 state machines. */
export const ASSESSMENT_INTERACTIVE_V2_SOURCE_PATHS = [
    'src/assessment_interactive_v2.ts',
    'src/assessment_blackbox_v2.ts',
    'src/assessment_documents_v2.ts',
    'src/assessment_delegated_release_v2.ts'
] as const;

const formats = {
    [ASSESSMENT_BLACKBOX_V2_TASK_FORMAT]: {
        name: 'identify',
        Simulator: BlackboxV2AssessmentSimulator,
        tools: assessment_blackbox_v2_tools
    },
    [ASSESSMENT_DOCUMENTS_V2_TASK_FORMAT]: {
        name: 'investigate',
        Simulator: DocumentV2AssessmentSimulator,
        tools: assessment_documents_v2_tools
    },
    [ASSESSMENT_DELEGATED_RELEASE_V2_TASK_FORMAT]: {
        name: 'release',
        Simulator: DelegatedReleaseV2AssessmentSimulator,
        tools: assessment_delegated_release_v2_tools
    }
} as const;

/** Build fresh per-sample simulators; unrelated descriptors belong to other loader registries. */
export function build_assessment_interactive_v2_task(value: unknown, grading: unknown): AssessmentTask | null {
    if (!is_assessment_object(grading) || typeof grading.type !== 'string' || !Object.hasOwn(formats, grading.type)) return null;
    const format = formats[grading.type as keyof typeof formats];
    if (
        !is_assessment_object(value) ||
        value.kind !== 'tool' ||
        !['id', 'title', 'domain', 'prompt', 'version'].every(key => typeof value[key] === 'string' && value[key].trim().length > 0) ||
        !assessment_exact_fields(grading, ['type', 'name', 'config']) ||
        grading.name !== format.name
    )
        throw new Error('Assessment interactive v2 requires a tool card and a matching named grading descriptor');
    const descriptor = structuredClone(grading);
    const create = () => new format.Simulator(descriptor.config);
    create(); // Reject malformed published descriptors when loading, before any request.
    const card = structuredClone(value) as AssessmentTask;
    card.grading = structuredClone(descriptor);
    card.tools = format.tools();
    card.make_simulator = create;
    card.grade = () => ({
        content_score: null,
        content_checks: {},
        instruction_checks: {},
        tool_checks: {},
        outcome: 'ungradable',
        reason: 'Grade using the simulator that received the tool calls.'
    });
    return card;
}
