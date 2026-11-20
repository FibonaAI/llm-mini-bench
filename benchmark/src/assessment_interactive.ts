import { ASSESSMENT_BLACKBOX_TASK_FORMAT, configure_assessment_blackbox_task } from './assessment_blackbox.ts';
import { ASSESSMENT_DOCUMENTS_TASK_FORMAT, configure_assessment_documents_task } from './assessment_documents.ts';
import { ASSESSMENT_DELEGATED_RELEASE_TASK_FORMAT, configure_assessment_delegated_release_task } from './assessment_delegated_release.ts';
import type { AssessmentTask } from './assessment_tasks.ts';

/** Interactive simulator modules hashed in bank manifests that use them. */
export const ASSESSMENT_INTERACTIVE_SOURCE_PATHS = ['src/assessment_interactive.ts', 'src/assessment_blackbox.ts', 'src/assessment_documents.ts', 'src/assessment_delegated_release.ts'] as const;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const INTERACTIVE_FORMATS = new Set<string>([ASSESSMENT_BLACKBOX_TASK_FORMAT, ASSESSMENT_DELEGATED_RELEASE_TASK_FORMAT, ASSESSMENT_DOCUMENTS_TASK_FORMAT]);

/** Configure an interactive simulator card when the grading descriptor uses an interactive format. */
export function build_assessment_interactive_task(card: AssessmentTask, grading: unknown): AssessmentTask | null {
    const type = object(grading) && typeof grading.type === 'string' ? grading.type : '';
    if (!INTERACTIVE_FORMATS.has(type)) return null;
    for (const key of ['id', 'title', 'domain', 'kind', 'prompt', 'version']) {
        if (!nonempty(card[key])) throw new Error('Assessment interactive task requires nonempty ' + key);
    }
    if (type === ASSESSMENT_BLACKBOX_TASK_FORMAT) {
        const descriptor = grading as Record<string, unknown> & { config: unknown };
        if (Object.keys(descriptor).length !== 3 || descriptor.name !== 'identify' || card.kind !== 'tool') throw new Error('Assessment black-box grading requires identify, a tool card and config');
        const task = configure_assessment_blackbox_task(card, descriptor.config);
        task.grading = structuredClone(descriptor);
        return task;
    }
    if (type === ASSESSMENT_DELEGATED_RELEASE_TASK_FORMAT) {
        const descriptor = grading as Record<string, unknown> & { config: unknown };
        if (Object.keys(descriptor).length !== 3 || descriptor.name !== 'release' || card.kind !== 'tool') throw new Error('Assessment delegated release grading requires release, a tool card and config');
        const task = configure_assessment_delegated_release_task(card, descriptor.config);
        task.grading = structuredClone(descriptor);
        return task;
    }
    if (type === ASSESSMENT_DOCUMENTS_TASK_FORMAT) {
        const descriptor = grading as Record<string, unknown> & { config: unknown };
        if (Object.keys(descriptor).length !== 3 || descriptor.name !== 'investigate' || card.kind !== 'tool') throw new Error('Assessment document grading requires investigate, a tool card and config');
        const task = configure_assessment_documents_task(card, descriptor.config);
        task.grading = structuredClone(descriptor);
        return task;
    }
    return null;
}
