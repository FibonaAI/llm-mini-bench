/**
 * Tool-submitted answers. A task that declares `answer_protocol: "submit-answer-tool-v1"` is graded
 * only from the arguments of its last `submit_answer` call; visible text is never parsed for an answer.
 * The task field participates in task snapshots and hashes, so opting in is an explicit bank change.
 */
import type { RunnerGrade } from './assessment_runner.ts';

export const SUBMIT_ANSWER_PROTOCOL = 'submit-answer-tool-v1';
export const SUBMIT_ANSWER_TOOL_NAME = 'submit_answer';

/**
 * Arguments are the answer fields themselves. Each task supplies `answer_schema`: a JSON Schema object
 * naming the answer fields and value types (never values). A free-form object schema was rejected after a
 * live smoke test: several models wrapped the whole answer into one invented string argument.
 */
export function submit_answer_tool(schema: Record<string, unknown>) {
    return {
        type: 'function',
        name: SUBMIT_ANSWER_TOOL_NAME,
        description:
            'Submit your final answer. Pass each answer field as a separate argument with the value type shown; do not wrap the answer in a string. Only the last submission is graded.',
        parameters: structuredClone(schema)
    };
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Validate the declared top-level answer fields; nested shapes may stay loose. */
export function task_answer_schema(task: Record<string, unknown>): Record<string, unknown> {
    const schema = task.answer_schema;
    if (
        !record(schema) ||
        schema.type !== 'object' ||
        !record(schema.properties) ||
        !Object.keys(schema.properties).length ||
        !Object.values(schema.properties).every(record) ||
        (schema.required !== undefined &&
            !(
                Array.isArray(schema.required) &&
                schema.required.every(key => typeof key === 'string' && Object.hasOwn(schema.properties as object, key))
            ))
    )
        throw new TypeError('submit-answer tasks require answer_schema: an object schema with named properties');
    return schema;
}

/** Protocol instructions sent as the request `instructions`; recorded in the protocol hash. */
export const SUBMIT_ANSWER_INSTRUCTIONS =
    'Submit your final answer by calling the submit_answer tool with the answer object as its arguments. Text replies are not graded. Only your last submit_answer call counts. After submitting, end your turn.';

/** Acknowledgement returned to the model after a valid submission. */
export const SUBMIT_ANSWER_ACCEPTED = Object.freeze({
    accepted: true,
    message: 'Answer recorded. Only your last submission is graded. End your turn now.'
});

/** Fail closed on unknown protocol identifiers; absent means legacy text answers. */
export function task_answer_protocol(task: Record<string, unknown>): typeof SUBMIT_ANSWER_PROTOCOL | null {
    const value = task.answer_protocol;
    if (value === undefined) return null;
    if (value !== SUBMIT_ANSWER_PROTOCOL) throw new TypeError('Unsupported task answer_protocol');
    task_answer_schema(task);
    return SUBMIT_ANSWER_PROTOCOL;
}

/** Hash input describing the exact tool definition and instructions a protocol sends. */
export function answer_protocol_spec(task: Record<string, unknown>): Record<string, unknown> | null {
    return task_answer_protocol(task)
        ? { id: SUBMIT_ANSWER_PROTOCOL, tool: submit_answer_tool(task_answer_schema(task)), instructions: SUBMIT_ANSWER_INSTRUCTIONS }
        : null;
}

/** A completed agent that never submitted made no answer: a valid zero, not an ungradable result. */
export function no_submission_grade(): RunnerGrade {
    return {
        content_score: 0,
        content_checks: {},
        instruction_checks: { submitted_via_tool: false },
        tool_checks: {},
        outcome: 'no_submission'
    };
}

/** Keep the original grade and mark that the answer came from the submission tool. */
export function submitted_grade(grade: RunnerGrade): RunnerGrade {
    const checks =
        grade && typeof grade.instruction_checks === 'object' && grade.instruction_checks !== null
            ? (grade.instruction_checks as Record<string, unknown>)
            : {};
    return { ...grade, instruction_checks: { ...checks, submitted_via_tool: true } };
}
