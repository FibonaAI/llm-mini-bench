import type { AssessmentTask } from './assessment_tasks.ts';
import { ASSESSMENT_BLACKBOX_TASK_FORMAT, configure_assessment_blackbox_task } from './assessment_blackbox.ts';
import { ASSESSMENT_DOCUMENTS_TASK_FORMAT, configure_assessment_documents_task } from './assessment_documents.ts';
import { ASSESSMENT_DEPOT_TASK_FORMAT, configure_assessment_depot_task } from './assessment_depot.ts';
import { ASSESSMENT_PUSH_PLANNING_TASK_FORMAT, configure_assessment_push_planning_task } from './assessment_push_planning.ts';
import { ASSESSMENT_DELEGATED_RELEASE_TASK_FORMAT, configure_assessment_delegated_release_task } from './assessment_delegated_release.ts';
import { ASSESSMENT_SAFE_CONTROL_TASK_FORMAT, configure_assessment_safe_control_task } from './assessment_safe_control.ts';

/** Optional interactive formats pinned separately from the original bank source map. */
export const ASSESSMENT_INTERACTIVE_SOURCE_PATHS = ['src/assessment_interactive.ts', 'src/assessment_blackbox.ts', 'src/assessment_documents.ts', 'src/assessment_depot.ts', 'src/assessment_push_planning.ts', 'src/assessment_delegated_release.ts', 'src/assessment_safe_control.ts'] as const;

/** Build only recognized extension descriptors; all other formats use the shared data loader. */
export function build_assessment_interactive_task(card: AssessmentTask, grading: unknown): AssessmentTask | null {
    if (grading === null || typeof grading !== 'object' || Array.isArray(grading)) return null;
    const type = (grading as Record<string, unknown>).type;
    if (![ASSESSMENT_BLACKBOX_TASK_FORMAT, ASSESSMENT_DOCUMENTS_TASK_FORMAT, ASSESSMENT_DEPOT_TASK_FORMAT, ASSESSMENT_PUSH_PLANNING_TASK_FORMAT, ASSESSMENT_DELEGATED_RELEASE_TASK_FORMAT, ASSESSMENT_SAFE_CONTROL_TASK_FORMAT].includes(type as string)) return null;
    const nonempty = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
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
    if (type === ASSESSMENT_DEPOT_TASK_FORMAT) {
        const descriptor = grading as Record<string, unknown> & { config: unknown };
        if (Object.keys(descriptor).length !== 3 || descriptor.name !== 'fulfill' || card.kind !== 'tool') throw new Error('Assessment depot grading requires fulfill, a tool card and config');
        const task = configure_assessment_depot_task(card, descriptor.config);
        task.grading = structuredClone(descriptor);
        return task;
    }
    if (type === ASSESSMENT_PUSH_PLANNING_TASK_FORMAT) {
        const descriptor = grading as Record<string, unknown> & { config: unknown };
        if (Object.keys(descriptor).length !== 3 || descriptor.name !== 'solve' || card.kind !== 'tool') throw new Error('Assessment push planning grading requires solve, a tool card and config');
        const task = configure_assessment_push_planning_task(card, descriptor.config);
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
    if (type === ASSESSMENT_SAFE_CONTROL_TASK_FORMAT) {
        const descriptor = grading as Record<string, unknown> & { config: unknown };
        if (Object.keys(descriptor).length !== 3 || descriptor.name !== 'dock' || card.kind !== 'tool') throw new Error('Assessment safe control grading requires dock, a tool card and config');
        const task = configure_assessment_safe_control_task(card, descriptor.config);
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
