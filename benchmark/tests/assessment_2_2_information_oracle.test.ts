import { describe, expect, test } from 'bun:test';
import { load_assessment_bank } from '../src/assessment_bank.ts';

type World = readonly [number, number, number];
const worlds: World[] = [];
for (let a = 0; a < 4; a++)
    for (let b = 0; b < 4; b++)
        for (let c = 0; c < 4; c++) {
            if (new Set([a, b, c]).size === 3 && a + b + c <= 5) worlds.push([a, b, c]);
        }
const relation = (world: World) => world[0] < world[2];
const signal = (world: World) => world[1] < world[2];
function informationCell(possible: World[], actual: World, agent: number): World[] {
    return possible.filter(world => world[agent] === actual[agent] && (agent !== 0 || signal(world) === signal(actual)));
}
function knowsValue(possible: World[], actual: World, agent: number, value: (world: World) => unknown): boolean {
    return new Set(informationCell(possible, actual, agent).map(value)).size === 1;
}
function applyAnnouncements(initial: World[], actual: World) {
    const stages = [initial];
    const transcript: boolean[] = [];
    for (const agent of [0, 1, 2]) {
        const possible = stages.at(-1)!;
        const question = agent === 1 ? (world: World) => world[0] : relation;
        const answer = knowsValue(possible, actual, agent, question);
        transcript.push(answer);
        stages.push(possible.filter(world => knowsValue(possible, world, agent, question) === answer));
    }
    return { stages, transcript };
}

describe('Assessment 2.2 private information oracle', () => {
    const task = load_assessment_bank('2.2').tasks.find(task => task.id === 'R22_Private_Information_Announcements')!;
    const actual: World = [0, 3, 2];
    const privateExecution = applyAnnouncements(worlds, actual);
    const remaining = privateExecution.stages.at(-1)!;
    const bobKnows = (world: World) => knowsValue(remaining, world, 1, candidate => candidate[0]);
    const publicExecution = applyAnnouncements(
        worlds.filter(world => signal(world) === signal(actual)),
        actual
    );

    test('partitions reproduce the independent hand proof without exposing the actual world', () => {
        expect(privateExecution.transcript).toEqual([true, false, false]);
        expect(privateExecution.stages.map(stage => stage.length)).toEqual([18, 16, 16, 7]);
        expect(remaining).toEqual([
            [0, 1, 2],
            [0, 2, 1],
            [0, 3, 1],
            [0, 3, 2],
            [1, 0, 2],
            [3, 0, 1],
            [3, 0, 2]
        ]);
        expect(informationCell(remaining, actual, 0)).toEqual([
            [0, 2, 1],
            [0, 3, 1],
            [0, 3, 2]
        ]);
        expect(informationCell(remaining, actual, 1)).toEqual([
            [0, 3, 1],
            [0, 3, 2]
        ]);
        expect(publicExecution.stages.map(stage => stage.length)).toEqual([9, 9, 9, 9]);
    });

    const answer = {
        public_probability_a_less_c: `${remaining.filter(relation).length}/${remaining.length}`,
        bob_final_a: informationCell(remaining, actual, 1).every(world => world[0] === actual[0]) ? actual[0] : 'unknown',
        alice_knows_bob_knows_a: informationCell(remaining, actual, 0).every(bobKnows),
        public_probability_bob_knows_a: `${remaining.filter(bobKnows).length}/${remaining.length}`,
        public_bit_transcript: publicExecution.transcript
    };
    test('accepts the independently computed posterior and higher-order knowledge', () => {
        expect(answer).toEqual({
            public_probability_a_less_c: '5/7',
            bob_final_a: 0,
            alice_knows_bob_knows_a: true,
            public_probability_bob_knows_a: '4/7',
            public_bit_transcript: [true, false, true]
        });
        expect(task.grade(JSON.stringify(answer)).content_score).toBe(1);
    });
    for (const [field, value] of Object.entries({
        public_probability_a_less_c: '1',
        bob_final_a: 'unknown',
        alice_knows_bob_knows_a: false,
        public_probability_bob_knows_a: '1',
        public_bit_transcript: [true, false, false]
    })) {
        test(`rejects a mistaken ${field}`, () => {
            expect(task.grade(JSON.stringify({ ...answer, [field]: value })).content_score).toBe(0.8);
        });
    }
});
