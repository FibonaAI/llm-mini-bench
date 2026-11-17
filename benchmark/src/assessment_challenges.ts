/** Finite author-defined context/code challenges. Model answers remain data, never code. */
import type { AssessmentTask, AssessmentGrade } from "./assessment_tasks.ts";
import { assessmentJsonNumberToken, stringifyAssessmentAnswerJson } from "./assessment_json.ts";

type RuleRow = [string, string, number, number, number, string, string, number, number];
type FactRow = [string, string, number, number, number, string, boolean, boolean];
type QueryRow = [string, string, number, number];
type Checks = Record<string, boolean>;
type Answer = Record<string, unknown>;
type ParseAnswer = (text: unknown) => [Answer | null, Checks, string | null];
type ResultFactory = (checks: Checks, instructions: Checks, outcome?: string | null, score?: number | null) => AssessmentGrade;
type GradeFields = (text: unknown, expected: Answer) => AssessmentGrade;

export const ASSESSMENT_CHALLENGE_VERSION = "assessment-challenges-0.1";

export const BITEMPORAL_RULE_ROWS: RuleRow[] = [
    [
        "P0",
        "base",
        1,
        1,
        30,
        "published",
        "all",
        0,
        0
    ],
    [
        "P1",
        "regional",
        5,
        10,
        20,
        "published",
        "EU",
        10,
        30
    ],
    [
        "P2",
        "regional",
        14,
        12,
        20,
        "published",
        "EU",
        10,
        20
    ],
    [
        "P3",
        "vip",
        6,
        8,
        20,
        "published",
        "VIP",
        20,
        50
    ],
    [
        "P4",
        "vip",
        15,
        8,
        20,
        "published",
        "EU_AND_VIP",
        20,
        40
    ],
    [
        "P5",
        "blocked",
        7,
        1,
        30,
        "published",
        "BLOCKED",
        100,
        0
    ],
    [
        "P6",
        "blocked",
        16,
        1,
        30,
        "draft",
        "all",
        100,
        99
    ]
];

export const BITEMPORAL_FACT_ROWS: FactRow[] = [
    [
        "F1",
        "A",
        2,
        1,
        30,
        "EU",
        false,
        false
    ],
    [
        "F2",
        "B",
        2,
        1,
        30,
        "US",
        true,
        false
    ],
    [
        "F3",
        "C",
        3,
        1,
        30,
        "EU",
        true,
        true
    ],
    [
        "F4",
        "C",
        15,
        1,
        30,
        "EU",
        true,
        false
    ]
];

export const BITEMPORAL_QUERIES: QueryRow[] = [
    [
        "a_early",
        "A",
        11,
        12
    ],
    [
        "a_late",
        "A",
        11,
        16
    ],
    [
        "b_early",
        "B",
        11,
        12
    ],
    [
        "b_late",
        "B",
        11,
        16
    ],
    [
        "c_early",
        "C",
        11,
        12
    ],
    [
        "c_late",
        "C",
        11,
        16
    ]
];

export const BITEMPORAL_EXPECTED: Record<string, { credit: number; rule_id: string; fact_id: string }> = {
    "a_early": {
        "credit": 30,
        "rule_id": "P1",
        "fact_id": "F1"
    },
    "a_late": {
        "credit": 0,
        "rule_id": "P0",
        "fact_id": "F1"
    },
    "b_early": {
        "credit": 50,
        "rule_id": "P3",
        "fact_id": "F2"
    },
    "b_late": {
        "credit": 0,
        "rule_id": "P0",
        "fact_id": "F2"
    },
    "c_early": {
        "credit": 0,
        "rule_id": "P5",
        "fact_id": "F3"
    },
    "c_late": {
        "credit": 40,
        "rule_id": "P4",
        "fact_id": "F4"
    }
};

export const TRANSACTION_EVENTS = [
    "rA",
    "cA",
    "rB",
    "cB",
    "rC",
    "cC"
];

export const TRANSACTION_EXPECTED = {
    "schedule_count": 90,
    "unguarded_violations": 72,
    "guarded_violations": 0,
    "guarded_abort_counts": {
        "0": 6,
        "1": 48,
        "2": 36
    },
    "guarded_remaining_one": 54
};

export const TRANSACTION_PROMPT = "Analyze this fully specified in-memory concurrent program. It is a toy transaction model, not a particular database's undocumented behavior. No code execution tools are available.\n\nInitially on_call = {\"A\":1,\"B\":1,\"C\":1}, version = 0, and pending is empty. Worker W runs exactly two indivisible events, rW then cW. An event cannot interleave internally. Workers never retry; an aborted or read-only commit still consumes its cW event.\n\nAuthor's fixed pseudocode:\nread(W):\n    pending[W] = (version, sum(on_call[X] for X != W) >= 1)\n\ncommit(W, guarded):\n    seen_version, leave = pending[W]\n    if not leave:\n        return \"read_only\"                 # no validation, no mutation\n    if guarded and seen_version != version:\n        return \"aborted\"                   # no mutation, no retry\n    on_call[W] = 0\n    version = version + 1\n    return \"committed\"\n\nThe expression at read uses the current shared on_call values at that event. The saved leave and seen_version never change. A successful write increments version even in the unguarded mode. The intended safety invariant is sum(on_call.values()) >= 1 AFTER all six events.\n\nA schedule is a sequence containing rA,cA,rB,cB,rC,cC exactly once, subject ONLY to rA<cA, rB<cB, rC<cC. Count each distinct event sequence once; do not identify sequences by final state or permute indistinguishable labels. Evaluate each schedule from the same initial state in both modes, guarded=false and guarded=true.\n\nReturn exactly one JSON object with these fields:\n- schedule_count: number of legal schedules.\n- unguarded_violations: number ending with sum(on_call)=0 in unguarded mode.\n- guarded_violations: number ending with sum(on_call)=0 in guarded mode.\n- guarded_abort_counts: object with string keys \"0\",\"1\",\"2\", giving the number of schedules with exactly that many aborted commits in guarded mode. Read-only commits are NOT aborts.\n- guarded_remaining_one: number of schedules ending with exactly one worker on call in guarded mode.\n- bad_schedule: any legal six-element array of event strings witnessing a violation in UNGUARDED mode. Alternatives are accepted if they really violate the invariant.\nAll counts must be JSON integers. No extra fields. Do not return executable code or a claimed simulator trace instead of the event array.";

function is_assessment_integer(value: unknown, container: object, key: string): boolean {
    if (typeof value === "bigint") return true;
    if (typeof value !== "number" || !Number.isInteger(value)) return false;
    const token = assessmentJsonNumberToken(container, key);
    return token === undefined || !/[.eE]/.test(token);
}

function isRecord(value: unknown): value is Answer {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Answer, keys: string[]): boolean {
    return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function _rule_matches_fact(scope: string, fact: FactRow): boolean {
    const [, , , , , region, vip, blocked] = fact;
    const predicates: Checks = { all: true, EU: region === "EU", VIP: vip, EU_AND_VIP: region === "EU" && vip, BLOCKED: blocked };
    return predicates[scope]!;
}

/** Resolve latest-known complete revisions BEFORE intervals and eligibility predicates. */
export function oracle_bitemporal_decisions(): typeof BITEMPORAL_EXPECTED {
    const answers: typeof BITEMPORAL_EXPECTED = {};
    for (const [query_id, customer, effective_day, known_day] of BITEMPORAL_QUERIES) {
        const latest_rules = new Map<string, RuleRow>();
        for (const row of [...BITEMPORAL_RULE_ROWS].sort((a, b) => a[2] - b[2])) {
            if (row[2] <= known_day && row[5] === "published") latest_rules.set(row[1], row);
        }
        const fact = BITEMPORAL_FACT_ROWS.filter(row => row[1] === customer && row[2] <= known_day)
            .reduce((a, b) => a[2] >= b[2] ? a : b);
        if (!(fact[3] <= effective_day && effective_day < fact[4])) throw new Error("Bitemporal chosen fact is outside its interval");
        const eligible = [...latest_rules.values()].filter(row => row[3] <= effective_day && effective_day < row[4] && _rule_matches_fact(row[6], fact));
        const winner = eligible.reduce((a, b) => a[7] >= b[7] ? a : b);
        if (eligible.filter(row => row[7] === winner[7]).length !== 1) throw new Error("Bitemporal winning priorities must not tie");
        answers[query_id] = { credit: winner[8], rule_id: winner[0], fact_id: fact[0] };
    }
    return answers;
}

/** Accept exactly six named read/commit events, each read preceding its commit. */
export function valid_transaction_schedule(schedule: unknown): schedule is string[] {
    return Array.isArray(schedule) && schedule.length === 6
        && schedule.every((event: unknown) => typeof event === "string")
        && new Set(schedule).size === 6 && TRANSACTION_EVENTS.every(event => schedule.includes(event))
        && [..."ABC"].every(worker => schedule.indexOf("r" + worker) < schedule.indexOf("c" + worker));
}

/** Simulate only the fixed author's program; event strings are labels, never executable code. */
export function simulate_transaction_schedule(schedule: unknown, guarded: boolean): {
    on_call: Record<string, number>; aborts: number; version: number;
} {
    if (!valid_transaction_schedule(schedule)) throw new Error("Transaction schedule must contain each event once with read before commit");
    const on_call: Record<string, number> = { A: 1, B: 1, C: 1 };
    let version = 0, aborts = 0;
    const snapshots: Record<string, [number, boolean]> = {};
    for (const event of schedule) {
        const action = event[0]!, worker = event[1]!;
        if (action === "r") {
            snapshots[worker] = [version, Object.entries(on_call).filter(([key]) => key !== worker).reduce((sum, [, value]) => sum + value, 0) >= 1];
        } else {
            const [seen_version, leave] = snapshots[worker]!;
            if (!leave) continue;
            if (guarded && seen_version !== version) { aborts++; continue; }
            on_call[worker] = 0;
            version++;
        }
    }
    return { on_call, aborts, version };
}

function* permutations<T>(values: readonly T[]): Generator<T[]> {
    if (!values.length) { yield []; return; }
    for (let index = 0; index < values.length; index++) {
        for (const rest of permutations([...values.slice(0, index), ...values.slice(index + 1)])) yield [values[index]!, ...rest];
    }
}

/** Exhaust all legal event permutations and count safety violations and guarded outcomes. */
export function oracle_transaction_schedules(): typeof TRANSACTION_EXPECTED {
    const answer = { schedule_count: 0, unguarded_violations: 0, guarded_violations: 0,
        guarded_abort_counts: { "0": 0, "1": 0, "2": 0 }, guarded_remaining_one: 0 };
    for (const schedule of permutations(TRANSACTION_EVENTS)) {
        if (!valid_transaction_schedule(schedule)) continue;
        answer.schedule_count++;
        const unguarded = simulate_transaction_schedule(schedule, false);
        const guarded = simulate_transaction_schedule(schedule, true);
        answer.unguarded_violations += Number(Object.values(unguarded.on_call).reduce((a, b) => a + b, 0) === 0);
        const remaining = Object.values(guarded.on_call).reduce((a, b) => a + b, 0);
        answer.guarded_violations += Number(remaining === 0);
        answer.guarded_abort_counts[String(guarded.aborts) as "0" | "1" | "2"]++;
        answer.guarded_remaining_one += Number(remaining === 1);
    }
    return answer;
}

function _parse_challenge_answer(text: unknown, parse_answer: ParseAnswer, result_factory: ResultFactory): [Answer | null, Checks, AssessmentGrade | null] {
    const [obj, instructions, problem] = parse_answer(text);
    if (problem) return [null, instructions, result_factory({}, instructions, problem, problem === "abstained" ? 0 : null)];
    if (!isRecord(obj)) return [null, instructions, result_factory({}, instructions, "ungradable", null)];
    return [obj, instructions, null];
}

function _flatten_evidence_fields(obj: Answer): Answer {
    const fields: Answer = {};
    for (const query_id of Object.keys(BITEMPORAL_EXPECTED)) {
        const row = obj[query_id];
        if (isRecord(row)) {
            for (const [key, value] of Object.entries(row)) {
                if (["credit", "rule_id", "fact_id"].includes(key)) fields[query_id + "." + key] = value;
            }
        } else if (typeof row === "string") {
            for (const key of ["credit", "rule_id", "fact_id"]) fields[query_id + "." + key] = row;
        }
    }
    return fields;
}

function _grade_bitemporal_answer(text: unknown, grade_fields: GradeFields, parse_answer: ParseAnswer, result_factory: ResultFactory): AssessmentGrade {
    const [parsed, instructions, failure] = _parse_challenge_answer(text, parse_answer, result_factory);
    if (failure !== null) return failure;
    const obj = parsed!;
    const actual = _flatten_evidence_fields(obj), expected = _flatten_evidence_fields(BITEMPORAL_EXPECTED);
    const graded = grade_fields(stringifyAssessmentAnswerJson(actual), expected);
    const keys = Object.keys(BITEMPORAL_EXPECTED);
    instructions.exact_fields = exactKeys(obj, keys);
    instructions.decision_schema = keys.every(key => isRecord(obj[key]) && exactKeys(obj[key], ["credit", "rule_id", "fact_id"]));
    instructions.integer_credits = keys.every(key => {
        const row = obj[key];
        return isRecord(row) && is_assessment_integer(row.credit, row, "credit");
    });
    graded.instruction_checks = instructions;
    return graded;
}

function _flatten_transaction_counts(obj: Answer): Answer {
    const result: Answer = {};
    for (const key of ["schedule_count", "unguarded_violations", "guarded_violations", "guarded_remaining_one"]) {
        if (Object.hasOwn(obj, key)) result[key] = obj[key];
    }
    const histogram = obj.guarded_abort_counts;
    if (isRecord(histogram)) {
        for (const key of ["0", "1", "2"]) if (Object.hasOwn(histogram, key)) result["guarded_abort_counts." + key] = histogram[key];
    } else if (typeof histogram === "string") {
        for (const key of ["0", "1", "2"]) result["guarded_abort_counts." + key] = histogram;
    }
    return result;
}

function _grade_transaction_answer(text: unknown, grade_fields: GradeFields, parse_answer: ParseAnswer, result_factory: ResultFactory): AssessmentGrade {
    const [parsed, instructions, failure] = _parse_challenge_answer(text, parse_answer, result_factory);
    if (failure !== null) return failure;
    const obj = parsed!;
    const actual = _flatten_transaction_counts(obj), expected = _flatten_transaction_counts(TRANSACTION_EXPECTED);
    const graded = grade_fields(stringifyAssessmentAnswerJson(actual), expected);
    const witness = obj.bad_schedule, witness_valid = valid_transaction_schedule(witness);
    const checks: Checks = { ...graded.content_checks };
    checks.bad_schedule = witness_valid && Object.values(simulate_transaction_schedule(witness, false).on_call).reduce((a, b) => a + b, 0) === 0;
    const histogram = obj.guarded_abort_counts;
    instructions.exact_fields = exactKeys(obj, [...Object.keys(TRANSACTION_EXPECTED), "bad_schedule"]);
    instructions.histogram_schema = isRecord(histogram) && exactKeys(histogram, ["0", "1", "2"]);
    instructions.integer_counts = Object.keys(actual).length === Object.keys(expected).length && Object.keys(actual).every(key => {
        if (key.startsWith("guarded_abort_counts.")) {
            const bin = key.slice("guarded_abort_counts.".length);
            return isRecord(histogram) && is_assessment_integer(histogram[bin], histogram, bin);
        }
        return is_assessment_integer(obj[key], obj, key);
    });
    instructions.schedule_schema = witness_valid;
    const abstentions: Checks = { ...graded.abstention_checks };
    abstentions.bad_schedule = typeof witness === "string" && parse_answer(witness)[2] === "abstained";
    const incorrect: Checks = { ...graded.asserted_incorrect_checks };
    incorrect.bad_schedule = Object.hasOwn(obj, "bad_schedule") && !checks.bad_schedule && !abstentions.bad_schedule;
    const result = result_factory(checks, instructions, Object.values(abstentions).every(Boolean) ? "abstained" : null);
    result.abstention_checks = abstentions;
    result.asserted_incorrect_checks = incorrect;
    return result;
}

function _bitemporal_prompt(): string {
    const rule_rows = BITEMPORAL_RULE_ROWS.map(row => "| " + row.join(" | ") + " |").join("\n");
    const fact_rows = BITEMPORAL_FACT_ROWS.map(row => "| " + row.map(String).join(" | ") + " |").join("\n");
    const query_rows = BITEMPORAL_QUERIES.map(([qid, customer, effective, known]) => qid + ": customer " + customer + ", business day " + effective + ", knowledge cutoff " + known + ".").join("\n");
    return "Compute credits using ONLY the following revision log. Business day D and knowledge cutoff K are different axes. These are corrections to complete records, NOT additive policy versions.\n\nApply this order exactly for EACH query:\n1. Ignore draft rule rows entirely: they never replace a published row. Ignore rows recorded after K.\n2. For each logical rule key, choose the remaining row with the greatest recorded day. For the queried customer's fact key, likewise choose its latest recorded row. Each chosen row replaces its whole earlier row; do not merge fields.\n3. ONLY AFTER choosing revisions, require valid_from <= D < valid_to. If a chosen rule fails this test, that logical rule is absent. Do NOT fall back to an earlier revision, even if it covered D. Every query has a valid chosen fact row.\n4. Using the chosen fact, retain applicable rules. Scope all always matches; EU means region EU; VIP means vip=true in any region; EU_AND_VIP requires both; BLOCKED means blocked=true.\n5. The applicable rule with greatest priority wins; use its credit exactly, not a sum. Priorities do not tie. Return that winning physical rule ID and the chosen physical fact ID as evidence. A zero-credit rule is a valid decision.\n\nRule rows:\n| id | logical_key | recorded | valid_from | valid_to | status | scope | priority | credit |\n" + rule_rows + "\n\nFact rows (all authoritative; same complete-row replacement rule):\n| id | customer_key | recorded | valid_from | valid_to | region | vip | blocked |\n" + fact_rows + "\n\nQueries:\n" + query_rows + "\n\nReturn exactly one JSON object with keys a_early,a_late,b_early,b_late,c_early,c_late. Each value must be an object with ONLY credit (integer), rule_id (string), fact_id (string). No extra fields. Evidence IDs must refer to physical rows, not logical keys. Do not use outside policy knowledge.";
}

/** Build the two challenge cards with the caller's answer parser and scoring policy. */
export function build_assessment_challenge_tasks(grade_fields: GradeFields, parse_answer: ParseAnswer, result_factory: ResultFactory): AssessmentTask[] {
    return [
{
    "kind": "text",
    "version": "assessment-challenges-0.1",
    "source": [
        "Author-defined finite specification with frozen answers and independent test oracles"
    ],
    "id": "X03_Bitemporal_Revisions",
    "title": "Bitemporal corrections and policy precedence",
    "domain": "context",
    "prompt": _bitemporal_prompt(),
    "difficulty_intent": "Resolve two time axes, whole-row corrections, predicate applicability and priority; empirically uncalibrated",
    "measurement": {
        "necessary_operations": [
            "filter publication and knowledge cutoff",
            "resolve complete-row revision identity before validity or applicability",
            "combine corrected customer facts with policy predicates",
            "select winning priority and physical evidence IDs"
        ],
        "confounds": "Six paired queries share one rule log; 18 field checks are correlated, not 18 independent ability samples. Financial semantics are supplied, not assumed.",
        "status": "uncalibrated challenge candidate; no live discrimination or reliability claim"
    },
    "scoring_rule": "Equal mean over 18 semantic atoms: each of six decisions has credit, rule_id and fact_id. JSON shape/integer-type checks recorded separately."
,
    grade: (text: unknown) => _grade_bitemporal_answer(text, grade_fields, parse_answer, result_factory)
},
{
    "kind": "text",
    "version": "assessment-challenges-0.1",
    "source": [
        "Author-defined finite specification with frozen answers and independent test oracles"
    ],
    "id": "C03_Optimistic_Transactions",
    "title": "Write-skew schedules and optimistic version validation",
    "domain": "code",
    "prompt": TRANSACTION_PROMPT,
    "difficulty_intent": "Track saved reads, live commits, invalidation and read-only versus aborted execution; count and construct witnesses",
    "measurement": {
        "necessary_operations": [
            "track shared versus saved transaction state",
            "enumerate precedence-constrained interleavings",
            "diagnose write skew under stale decisions",
            "distinguish aborted writes from read-only commits",
            "verify a concrete counterexample to the invariant"
        ],
        "confounds": "Finite schedule counting contributes combinatorial load; this is not a measure of production database expertise, implementation speed, or long-horizon programming.",
        "status": "uncalibrated challenge candidate; no live discrimination or reliability claim"
    },
    "scoring_rule": "Equal mean over 8 atoms: schedule total, two violation counts, three abort histogram bins, one remaining-worker count, and an executable-by-author-simulator counterexample. Never execute model code."
,
    grade: (text: unknown) => _grade_transaction_answer(text, grade_fields, parse_answer, result_factory)
},
    ];
}
