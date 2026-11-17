import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import {
    ASSESSMENT_CHALLENGE_VERSION,
    BITEMPORAL_EXPECTED,
    BITEMPORAL_FACT_ROWS,
    BITEMPORAL_QUERIES,
    BITEMPORAL_RULE_ROWS,
    TRANSACTION_EXPECTED,
    build_assessment_challenge_tasks,
    oracle_bitemporal_decisions,
    oracle_transaction_schedules,
    simulate_transaction_schedule,
    valid_transaction_schedule
} from './assessment_challenges.ts';
import { assessment_result, grade_assessment_fields, parse_assessment_answer } from './assessment_tasks.ts';
import type { AssessmentGrade } from './assessment_tasks.ts';

type Simulation = ReturnType<typeof simulate_transaction_schedule>;
const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/assessment-challenges.json', import.meta.url), 'utf8')) as {
    cards: Record<string, unknown>[];
    grades: { task_id: string; text: unknown; expected: AssessmentGrade }[];
    schedules: { schedule: string[]; valid: boolean; unguarded?: Simulation; guarded?: Simulation }[];
};
const tasks = build_assessment_challenge_tasks(grade_assessment_fields, parse_assessment_answer, assessment_result);
const taskById = Object.fromEntries(tasks.map(task => [task.id, task]));
const transactionAnswer = { ...TRANSACTION_EXPECTED, bad_schedule: ['rA', 'rB', 'rC', 'cA', 'cB', 'cC'] };

/** Relational ranking resolves revisions before eligibility; no production oracle is reused. */
function independent_bitemporal_sql(): typeof BITEMPORAL_EXPECTED {
    const connection = new Database(':memory:');
    try {
        connection.run(
            'CREATE TABLE rules (id TEXT, logical_key TEXT, recorded INT, valid_from INT, valid_to INT, publication TEXT, scope TEXT, priority INT, credit INT)'
        );
        connection.run(
            'CREATE TABLE facts (id TEXT, customer TEXT, recorded INT, valid_from INT, valid_to INT, region TEXT, vip INT, blocked INT)'
        );
        for (const row of BITEMPORAL_RULE_ROWS) connection.query('INSERT INTO rules VALUES (?,?,?,?,?,?,?,?,?)').run(...row);
        for (const row of BITEMPORAL_FACT_ROWS)
            connection
                .query('INSERT INTO facts VALUES (?,?,?,?,?,?,?,?)')
                .run(...row.map(value => (typeof value === 'boolean' ? Number(value) : value)));
        const result: typeof BITEMPORAL_EXPECTED = {};
        const query = connection.query<
            { credit: number; rule_id: string; fact_id: string },
            { $known: number; $business: number; $customer: string }
        >(`
            WITH revisions AS (
                SELECT *, ROW_NUMBER() OVER (PARTITION BY logical_key ORDER BY recorded DESC) AS rank
                FROM rules WHERE publication = 'published' AND recorded <= $known
            ), fact_revisions AS (
                SELECT *, ROW_NUMBER() OVER (ORDER BY recorded DESC) AS rank
                FROM facts WHERE customer = $customer AND recorded <= $known
            )
            SELECT r.credit, r.id AS rule_id, f.id AS fact_id
            FROM revisions r CROSS JOIN fact_revisions f
            WHERE r.rank = 1 AND f.rank = 1
              AND r.valid_from <= $business AND $business < r.valid_to
              AND f.valid_from <= $business AND $business < f.valid_to
              AND (r.scope = 'all' OR (r.scope = 'EU' AND f.region = 'EU')
                OR (r.scope = 'VIP' AND f.vip = 1)
                OR (r.scope = 'EU_AND_VIP' AND f.region = 'EU' AND f.vip = 1)
                OR (r.scope = 'BLOCKED' AND f.blocked = 1))
            ORDER BY r.priority DESC
        `);
        for (const [key, customer, business, known] of BITEMPORAL_QUERIES) {
            const row = query.get({ $known: known, $business: business, $customer: customer });
            if (!row) throw new Error('Independent SQL oracle has no applicable winner');
            result[key] = row;
        }
        return result;
    } finally {
        connection.close();
    }
}

/** Count transition paths without event permutations or the production event simulator. */
function independent_transaction_state_search(guarded: boolean): Record<string, number> {
    const cache = new Map<string, Record<string, number>>();
    function visit(
        stages: number[],
        bits: number[],
        version: number,
        saved_versions: number[],
        decisions: boolean[],
        aborts: number
    ): Record<string, number> {
        if (stages.every(stage => stage === 2)) return { [bits.reduce((a, b) => a + b, 0) + ',' + aborts]: 1 };
        const key = JSON.stringify([stages, bits, version, saved_versions, decisions, aborts]);
        const cached = cache.get(key);
        if (cached) return cached;
        const counts: Record<string, number> = {};
        for (let worker = 0; worker < 3; worker++) {
            if (stages[worker] === 2) continue;
            const next_stages = [...stages],
                next_bits = [...bits],
                next_versions = [...saved_versions],
                next_decisions = [...decisions];
            next_stages[worker] = next_stages[worker]! + 1;
            let next_version = version,
                next_aborts = aborts;
            if (stages[worker] === 0) {
                next_versions[worker] = version;
                next_decisions[worker] = bits.some((bit, other) => other !== worker && Boolean(bit));
            } else if (decisions[worker]) {
                if (guarded && saved_versions[worker] !== version) next_aborts++;
                else {
                    next_bits[worker] = 0;
                    next_version++;
                }
            }
            const child = visit(next_stages, next_bits, next_version, next_versions, next_decisions, next_aborts);
            for (const [outcome, count] of Object.entries(child)) counts[outcome] = (counts[outcome] ?? 0) + count;
        }
        cache.set(key, counts);
        return counts;
    }
    return visit([0, 0, 0], [1, 1, 1], 0, [-1, -1, -1], [false, false, false], 0);
}

describe('assessment challenges Python differential parity', () => {
    test('task cards and prompt bytes are unchanged', () => {
        expect(fixture.cards).toEqual(tasks.map(({ grade, ...card }) => card));
        expect(tasks.map(task => task.id)).toEqual(['X03_Bitemporal_Revisions', 'C03_Optimistic_Transactions']);
        for (const task of tasks) {
            expect(task.version).toBe(ASSESSMENT_CHALLENGE_VERSION);
            expect(task.kind).toBe('text');
            expect(task.prompt).toContain('JSON object');
            expect(task.prompt.length).toBeLessThan(6000);
            expect(task).not.toHaveProperty('thinking');
            expect(task).not.toHaveProperty('effort');
        }
    });
    for (const [index, row] of fixture.grades.entries()) {
        test(`Python grade ${index}: ${row.task_id}`, () => {
            expect(taskById[row.task_id]!.grade(row.text)).toEqual(row.expected);
        });
    }
    test('400-digit JSON integers remain integer-typed but semantically incorrect', () => {
        const cases = fixture.grades.filter(row => typeof row.text === 'string' && /9{400}/.test(row.text));
        expect(cases).toHaveLength(30);
        for (const row of cases) {
            const result = taskById[row.task_id]!.grade(row.text);
            expect(result).toEqual(row.expected);
            expect(result.outcome).toBe('incorrect');
            expect(result.content_score).not.toBeNull();
            // Nested objects/arrays are deliberately invalid types; scalar huge ints remain ints.
            if (row.expected.instruction_checks.integer_credits || row.expected.instruction_checks.integer_counts) {
                expect(result.instruction_checks.integer_credits ?? result.instruction_checks.integer_counts).toBe(true);
            }
        }
    });
    test('all 720 event permutations match Python validation and simulation', () => {
        let valid = 0;
        for (const row of fixture.schedules) {
            expect(valid_transaction_schedule(row.schedule)).toBe(row.valid);
            if (row.valid) {
                valid++;
                expect(simulate_transaction_schedule(row.schedule, false)).toEqual(row.unguarded!);
                expect(simulate_transaction_schedule(row.schedule, true)).toEqual(row.guarded!);
            } else {
                expect(() => simulate_transaction_schedule(row.schedule, true)).toThrow(
                    'Transaction schedule must contain each event once with read before commit'
                );
            }
        }
        expect(valid).toBe(90);
    });
});

describe('independent challenge oracles and grading boundaries', () => {
    test('bitemporal frozen answers match independent SQL window ranking', () => {
        expect(oracle_bitemporal_decisions()).toEqual(BITEMPORAL_EXPECTED);
        expect(independent_bitemporal_sql()).toEqual(BITEMPORAL_EXPECTED);
    });
    test('whole-row corrections, narrower scope, drafts and corrected facts remain distinct', () => {
        const answer = independent_bitemporal_sql();
        expect([answer.a_early!.credit, answer.a_late!.credit]).toEqual([30, 0]);
        expect([answer.b_early!.rule_id, answer.b_late!.rule_id]).toEqual(['P3', 'P0']);
        expect(answer.c_early).toEqual({ credit: 0, rule_id: 'P5', fact_id: 'F3' });
        expect(answer.c_late).toEqual({ credit: 40, rule_id: 'P4', fact_id: 'F4' });
    });
    test('row ordering does not change revision semantics', () => {
        BITEMPORAL_RULE_ROWS.reverse();
        BITEMPORAL_FACT_ROWS.reverse();
        try {
            expect(oracle_bitemporal_decisions()).toEqual(BITEMPORAL_EXPECTED);
        } finally {
            BITEMPORAL_RULE_ROWS.reverse();
            BITEMPORAL_FACT_ROWS.reverse();
        }
    });
    test('prompt contains the exact records and both query axes', () => {
        const prompt = taskById.X03_Bitemporal_Revisions!.prompt;
        for (const row of [...BITEMPORAL_RULE_ROWS, ...BITEMPORAL_FACT_ROWS])
            expect(prompt).toContain('| ' + row.map(String).join(' | ') + ' |');
        for (const [id, customer, day, known] of BITEMPORAL_QUERIES)
            expect(prompt).toContain(`${id}: customer ${customer}, business day ${day}, knowledge cutoff ${known}.`);
        expect(prompt).toContain('Do NOT fall back');
        expect(prompt).toContain('Ignore draft rule rows entirely');
    });
    test('all 18 bitemporal semantic atoms retain independent partial credit', () => {
        const grade = taskById.X03_Bitemporal_Revisions!.grade;
        expect(grade(JSON.stringify(BITEMPORAL_EXPECTED)).content_score).toBe(1);
        for (const query of Object.keys(BITEMPORAL_EXPECTED)) {
            for (const field of ['credit', 'rule_id', 'fact_id']) {
                const answer: Record<string, Record<string, unknown>> = structuredClone(BITEMPORAL_EXPECTED);
                answer[query]![field] = 'wrong';
                const result = grade(JSON.stringify(answer));
                expect(result.content_score).toBeCloseTo(17 / 18);
                expect(result.content_checks[query + '.' + field]).toBe(false);
            }
        }
        expect(grade('{"a_early":{"credit":30}}').content_score).toBeCloseTo(1 / 18);
    });
    test('evidence IDs are exact, never substrings or logical keys', () => {
        for (const bad of ['regional', 'P1 or P2', 'not P1', ['P1'], { id: 'P1' }]) {
            const answer = { ...BITEMPORAL_EXPECTED, a_early: { ...BITEMPORAL_EXPECTED.a_early, rule_id: bad } };
            expect(taskById.X03_Bitemporal_Revisions!.grade(JSON.stringify(answer)).content_checks['a_early.rule_id']).toBe(false);
        }
    });
    test('transaction counts match independent state-space search', () => {
        expect(oracle_transaction_schedules()).toEqual(TRANSACTION_EXPECTED);
        expect(independent_transaction_state_search(false)).toEqual({ '0,0': 72, '1,0': 18 });
        expect(independent_transaction_state_search(true)).toEqual({ '1,0': 6, '1,1': 48, '2,2': 36 });
    });
    test('read-only commits, aborts and version increments remain distinct', () => {
        expect(simulate_transaction_schedule(['rA', 'cA', 'rB', 'cB', 'rC', 'cC'], true)).toEqual({
            on_call: { A: 0, B: 0, C: 1 },
            aborts: 0,
            version: 2
        });
        expect(simulate_transaction_schedule(transactionAnswer.bad_schedule, false)).toEqual({
            on_call: { A: 0, B: 0, C: 0 },
            aborts: 0,
            version: 3
        });
        expect(simulate_transaction_schedule(transactionAnswer.bad_schedule, true)).toEqual({
            on_call: { A: 0, B: 1, C: 1 },
            aborts: 2,
            version: 1
        });
        expect(simulate_transaction_schedule(['rA', 'rB', 'cA', 'rC', 'cB', 'cC'], true)).toEqual({
            on_call: { A: 0, B: 1, C: 0 },
            aborts: 1,
            version: 2
        });
    });
    test('all 72 valid counterexamples are accepted, not a single canned sequence', () => {
        let accepted = 0;
        for (const row of fixture.schedules.filter(row => row.valid)) {
            const bad = Object.values(simulate_transaction_schedule(row.schedule, false).on_call).every(value => value === 0);
            const result = taskById.C03_Optimistic_Transactions!.grade(
                JSON.stringify({ ...transactionAnswer, bad_schedule: row.schedule })
            );
            expect(result.content_checks.bad_schedule).toBe(bad);
            expect(result.content_score).toBe(bad ? 1 : 7 / 8);
            accepted += Number(bad);
        }
        expect(accepted).toBe(72);
    });
    test('all eight transaction atoms retain independent partial credit', () => {
        const grade = taskById.C03_Optimistic_Transactions!.grade;
        expect(Object.keys(grade(JSON.stringify(transactionAnswer)).content_checks)).toHaveLength(8);
        for (const key of ['schedule_count', 'unguarded_violations', 'guarded_violations', 'guarded_remaining_one'])
            expect(grade(JSON.stringify({ ...transactionAnswer, [key]: 999 })).content_score).toBe(7 / 8);
        for (const bin of ['0', '1', '2'])
            expect(
                grade(
                    JSON.stringify({
                        ...transactionAnswer,
                        guarded_abort_counts: { ...transactionAnswer.guarded_abort_counts, [bin]: 999 }
                    })
                ).content_score
            ).toBe(7 / 8);
        expect(grade('{"guarded_violations":0}').content_score).toBe(1 / 8);
    });
    test('invalid schedules are data and cannot execute', () => {
        for (const schedule of [
            null,
            'rA,cA,rB,cB,rC,cC',
            [],
            ['rA', 'rA', 'rA', 'rA', 'rA', 'rA'],
            ['cA', 'rA', 'rB', 'cB', 'rC', 'cC'],
            ['rA', 'cA', 'rB', 'cB', 'rC', '__import__("os").system("echo bad")'],
            [['rA'], 'cA', 'rB', 'cB', 'rC', 'cC']
        ]) {
            expect(valid_transaction_schedule(schedule)).toBe(false);
            expect(() => simulate_transaction_schedule(schedule, true)).toThrow();
            expect(
                taskById.C03_Optimistic_Transactions!.grade(JSON.stringify({ ...transactionAnswer, bad_schedule: schedule })).content_score
            ).toBe(7 / 8);
        }
    });
});
