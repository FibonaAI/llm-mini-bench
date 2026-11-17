import { describe, expect, test } from 'bun:test';
import fixtures from '../tests/fixtures/assessment-graders.json';
import questions from '../banks/assessment-1.0.questions.json';
import {
    ASSESSMENT_EXPECTED, ASSESSMENT_TASKS, AssessmentFraction, grade_assessment_fields,
    interval_selection_counts, oracle_causal_counterfactual, oracle_parallel_schedule,
    oracle_payment_ledger, oracle_python_finally, oracle_stopping_urn, oracle_versioned_policy,
    parse_assessment_answer, grade_instruction_hierarchy, grade_instruction_transform, type AssessmentGrade,
} from './assessment_tasks.ts';

function decode_expected(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(decode_expected);
    if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        if (Array.isArray(object.$aliases)) return new Set(object.$aliases);
        if (typeof object.$fraction === 'string') {
            const [n, d = '1'] = object.$fraction.split('/');
            return new AssessmentFraction(BigInt(n!), BigInt(d));
        }
        return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, decode_expected(entry)]));
    }
    return value;
}
const catalog = new Map(ASSESSMENT_TASKS.map(task => [task.id, task]));
type Fixture = {type:string; id?:string; text:unknown; expected?:unknown; grade:AssessmentGrade; calls?: Array<[string, unknown]>};

describe('Python assessment grader differential fixtures', () => {
    for (const [i, fixture] of (fixtures.cases as unknown as Fixture[]).entries()) {
        test(`${i}: ${fixture.type} ${fixture.id ?? 'semantic fields'}`, () => {
            let grade;
            if (fixture.type === 'fields') grade = grade_assessment_fields(fixture.text, decode_expected(fixture.expected) as Record<string, unknown>);
            else if (fixture.type === 'tool') {
                const simulator = catalog.get(fixture.id!)!.make_simulator!();
                for (const [name, args] of fixture.calls!) simulator.call(name, args);
                grade = simulator.grade(fixture.text);
            } else grade = catalog.get(fixture.id!)!.grade(fixture.text);
            expect(grade).toEqual(fixture.grade);
        });
    }
});

test('all serializable candidate cards and every official question remain byte-content equivalent', () => {
    const cards = ASSESSMENT_TASKS.map(task => Object.fromEntries(Object.entries(task).filter(([, value]) => typeof value !== 'function')));
    expect(cards).toEqual(fixtures.cards);
    expect(questions).toHaveLength(14);
    expect(questions.map(question => cards.find(card => card.id === question.id))).toEqual(questions);
});

test('fixed author oracles match frozen expectations, not grader-derived answers', () => {
    const oracles = {R01_Stopping_Urn:oracle_stopping_urn, R02_Causal_Counterfactual:oracle_causal_counterfactual,
        R03_Parallel_Schedule:oracle_parallel_schedule, C01_Finally_Aliasing:oracle_python_finally,
        X01_Versioned_Rules:oracle_versioned_policy, X02_Payment_Evidence:oracle_payment_ledger};
    for (const [id, oracle] of Object.entries(oracles)) expect(oracle()).toEqual(ASSESSMENT_EXPECTED[id]);
});

test('urn independent conditional probability tree agrees with labeled permutation oracle', () => {
    const one = new AssessmentFraction(1), zero = new AssessmentFraction(0);
    const totals = [[3,2],[2,3]].map(([red,blue]) => {
        const terminal: Array<[string, AssessmentFraction]> = [];
        function visit(r:number,b:number,sequence:string,probability:AssessmentFraction):void {
            if (sequence.length === 4 || sequence.length >= 2 && sequence.at(-1) === sequence.at(-2)) {
                terminal.push([sequence,probability]); return;
            }
            if (r) visit(r-1,b,sequence+'R',probability.mul(new AssessmentFraction(r,r+b)));
            if (b) visit(r,b-1,sequence+'B',probability.mul(new AssessmentFraction(b,r+b)));
        }
        visit(red!,blue!,'',one);
        expect(terminal.reduce((sum,[,p]) => sum.add(p),zero)).toEqual(one);
        const selected = terminal.filter(([s]) => s.length >= 3 && s.at(-1) === 'R' && [...s].filter(c=>c==='R').length===2);
        return [selected.reduce((sum,[,p])=>sum.add(p),zero), selected.filter(([s])=>s.length===3).reduce((sum,[,p])=>sum.add(p),zero), selected.reduce((sum,[s,p])=>sum.add(p.mul(new AssessmentFraction(s.length))),zero)];
    });
    const priors = [new AssessmentFraction(2,5),new AssessmentFraction(3,5)];
    const weighted = (column:number) => totals.reduce((sum,row,i)=>sum.add(priors[i]!.mul(row[column]!)),zero);
    const evidence = weighted(0);
    const result: Record<string, AssessmentFraction> = {posterior_A:priors[0]!.mul(totals[0]![0]!).div(evidence),stop_at_3:weighted(1).div(evidence),expected_draws:weighted(2).div(evidence)};
    expect(result).toEqual(oracle_stopping_urn());
});

test('independent ready-job search preserves deliberate idling and vector multiplicity', () => {
    const durations:Record<string,number> = {A:2,B:1,C:2,D:2,E:1,F:1};
    const prerequisites:Record<string,string[]> = {A:[],B:[],C:['A'],D:['A','B'],E:['C'],F:['D','E']};
    const schedules = new Set<string>();
    function search(time:number,starts:Record<string,number>):void {
        if (time===6) {
            if (Object.keys(starts).length===6 && Object.entries(starts).every(([k,s])=>s+durations[k]!<=6)) schedules.add(JSON.stringify(Object.keys(durations).map(k=>starts[k])));
            return;
        }
        const complete = new Set(Object.entries(starts).filter(([k,s])=>s+durations[k]!<=time).map(([k])=>k));
        const running = Object.keys(starts).length-complete.size;
        const ready = Object.keys(durations).filter(k=>!(k in starts) && prerequisites[k]!.every(p=>complete.has(p)) && time+durations[k]!<=6);
        for (let mask=0;mask<2**ready.length;mask++) {
            const chosen = ready.filter((_,i)=>mask & (1<<i));
            if (chosen.length<=2-running) search(time+1,{...starts,...Object.fromEntries(chosen.map(k=>[k,time]))});
        }
    }
    search(0,{});
    const vectors = [...schedules].map(s=>JSON.parse(s) as number[]);
    expect(vectors).toHaveLength(5);
    expect(Math.max(...vectors.map(s=>s[1]!))).toBe(2);
    expect(Math.min(...vectors.map(s=>Math.max(...s.map((start,i)=>start+Object.values(durations)[i]!))))).toBe(6);
});

test('all finite-domain counterexample witnesses are accepted, not one memorized answer', () => {
    const intervals:number[][] = [];
    for (let a=0;a<6;a++) for (let b=a+1;b<7;b++) intervals.push([a,b]);
    let witnesses=0;
    for (let i=0;i<intervals.length;i++) for (let j=i+1;j<intervals.length;j++) for (let k=j+1;k<intervals.length;k++) {
        const rows=[intervals[i]!,intervals[j]!,intervals[k]!], [greedy,optimum]=interval_selection_counts(rows);
        if (greedy<optimum) { witnesses++; expect(catalog.get('C02_Greedy_Counterexample')!.grade(JSON.stringify({intervals:rows})).content_score).toBe(1); }
    }
    expect(witnesses).toBeGreaterThan(20);
});

test('JSON number lexical types preserve Python integer instruction checks and ambiguity', () => {
    expect(parse_assessment_answer('{"x":1} {"x":1.0}')[2]).toBe('ambiguous');
    expect(parse_assessment_answer('{"x":1.0} {"x":1e0}')[2]).toBeNull();
    expect(parse_assessment_answer('{"x":9007199254740992} {"x":9007199254740993}')[2]).toBe('ambiguous');
    const hierarchy=grade_instruction_hierarchy('{"senders":["ivy","zoe"],"count":2.0}');
    expect(hierarchy.content_score).toBe(1);
    expect(hierarchy.instruction_checks.integer_count).toBe(false);
    const transform=grade_instruction_transform('{"rows":[{"id":"A","word":"sun"},{"id":"C","word":"sky"},{"id":"D","word":"fox"}],"count":3e0,"checksum":19.0}');
    expect(transform.content_score).toBe(1);
    expect(transform.instruction_checks.count_integer).toBe(false);
    expect(transform.instruction_checks.weighted_checksum).toBe(false);
});
