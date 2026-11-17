import { describe, expect, test } from 'bun:test';
import { assessment_hash } from './assessment_json.ts';
import { assessment_sample_protocol, target_execution_protocol, type AssessmentSampleConfig } from './run_protocol.ts';

const task = { id: 'fixture', domain: 'test', kind: 'text', prompt: 'Return JSON.', grade() { return {}; } };
const base = { max_turns: null, max_tool_calls: null, timeout: 300 };

describe('sample protocol identity compatibility', () => {
    test('shared assembly matches the original formula across omitted, undefined, null and policy fields', () => {
        for (const max_output_tokens of ['omit', undefined, null, 128] as const) for (const max_api_retries of ['omit', undefined, 0, 3] as const) for (const timeout_scope of ['omit', undefined, 'sample'] as const) for (const thinking of ['default', 'none', 'high']) for (const stream of [false, true]) {
            const config: AssessmentSampleConfig = { ...base,
                ...(max_output_tokens === 'omit' ? {} : { max_output_tokens }),
                ...(max_api_retries === 'omit' ? {} : { max_api_retries }),
                ...(timeout_scope === 'omit' ? {} : { timeout_scope }) };
            const cap = config.max_output_tokens ?? undefined;
            const protocol = target_execution_protocol([{ id: task.id, ...(cap === undefined ? {} : { max_output_tokens: cap }) }], thinking, stream);
            const snapshot = Object.fromEntries(Object.entries(task).filter(([, value]) => typeof value !== 'function'));
            const configSnapshot = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
            expect(assessment_sample_protocol(task, thinking, config, stream)).toEqual({ execution_protocol: protocol, assessment_protocol_sha256: assessment_hash({ task: snapshot, config: configSnapshot, request_protocol: protocol }) });
        }
    });
    test('undefined is omitted but null and new policies remain distinct assessment identities', () => {
        const identity = (config: AssessmentSampleConfig, thinking = 'default', stream = true) => assessment_sample_protocol(task, thinking, config, stream);
        const omitted = identity(base);
        expect(identity({ ...base, max_output_tokens: undefined, max_api_retries: undefined, timeout_scope: undefined })).toEqual(omitted);
        const uncapped = identity({ ...base, max_output_tokens: null });
        expect(uncapped.execution_protocol).toEqual(omitted.execution_protocol);
        expect(uncapped.assessment_protocol_sha256).not.toBe(omitted.assessment_protocol_sha256);
        for (const config of [{ ...base, max_api_retries: 0 }, { ...base, timeout_scope: 'sample' as const }, { ...base, max_turns: 6 }, { ...base, max_tool_calls: 5 }]) {
            const changed = identity(config);
            expect(changed.execution_protocol).toEqual(omitted.execution_protocol);
            expect(changed.assessment_protocol_sha256).not.toBe(omitted.assessment_protocol_sha256);
        }
        expect(omitted.execution_protocol.requests.fixture).toEqual({ stream: true });
        expect(identity(base, 'none').execution_protocol.requests.fixture).toEqual({ stream: true, reasoning: { effort: 'none' } });
        expect(identity(base, 'default', false).execution_protocol.requests.fixture).toEqual({});
    });
});
