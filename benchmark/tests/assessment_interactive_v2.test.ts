import { describe, expect, test } from 'bun:test';
import { BlackboxV2AssessmentSimulator, assessment_blackbox_v2_tools } from '../src/assessment_blackbox_v2.ts';
import { DelegatedReleaseV2AssessmentSimulator } from '../src/assessment_delegated_release_v2.ts';
import { DocumentV2AssessmentSimulator } from '../src/assessment_documents_v2.ts';
import type { AssessmentDelegatedReleaseConfig } from '../src/assessment_delegated_release.ts';

const blackboxTable = {
    C0: { outputs: { P1: 0 as const, P2: 0 as const, P3: 0 as const } },
    C1: { outputs: { P1: 0 as const, P2: 0 as const, P3: 1 as const } },
    C2: { outputs: { P1: 0 as const, P2: 1 as const, P3: 0 as const } },
    C3: { outputs: { P1: 1 as const, P2: 1 as const, P3: 1 as const } },
    C4: { outputs: { P1: 1 as const, P2: 1 as const, P3: 1 as const } }
};
const solvableTable = {
    C0: { outputs: { M: 0 as const, R: 0 as const, X: 0 as const, Y: 0 as const } },
    C1: { outputs: { M: 0 as const, R: 0 as const, X: 0 as const, Y: 0 as const } },
    // Build a clean 5-candidate table where M splits 3:2 (mirage with twin pair on 0-branch) and R splits 1:4 -> 2:2 -> 1:1
    A0: { outputs: { G: 0 as const, R: 0 as const, S: 0 as const, T: 0 as const } },
    A1: { outputs: { G: 0 as const, R: 1 as const, S: 0 as const, T: 0 as const } },
    A2: { outputs: { G: 0 as const, R: 1 as const, S: 0 as const, T: 1 as const } },
    A3: { outputs: { G: 1 as const, R: 1 as const, S: 1 as const, T: 0 as const } },
    A4: { outputs: { G: 1 as const, R: 1 as const, S: 1 as const, T: 0 as const } }
};
void blackboxTable;
void solvableTable;

const asymmetricConfig = {
    query_limit: 3,
    expected_candidate: 'K1',
    // 5 candidates, limit 3:
    // G splits 3:2 (K0,K1,K2 vs K3,K4), where K0 and K1 agree on H and J (distinguished only by R!), wait: if R distinguishes K0/K1, can G->R->H solve?
    // Make K0,K1,K2 require 3 distinct leaves where no 2 probes separate all 3: e.g. on {H,J}, K0=00, K1=00, K2=01! Only R separates K0(0) from K1(1), while K3(1) and K4(1) ALSO only separate on... wait:
    // Simpler: on G=0 we have 5 candidates (impossible in 2 probes since 5 > 2^2 = 4!), while R splits 4:2 on 6 candidates!
    candidates: {
        K0: { outputs: { G: 0 as const, R: 0 as const, H: 0 as const, J: 0 as const } },
        K1: { outputs: { G: 0 as const, R: 0 as const, H: 0 as const, J: 1 as const } },
        K2: { outputs: { G: 0 as const, R: 0 as const, H: 1 as const, J: 0 as const } },
        K3: { outputs: { G: 1 as const, R: 0 as const, H: 1 as const, J: 1 as const } },
        K4: { outputs: { G: 1 as const, R: 1 as const, H: 0 as const, J: 0 as const } },
        K5: { outputs: { G: 1 as const, R: 1 as const, H: 0 as const, J: 1 as const } }
    }
};
// Wait: in asymmetricConfig above, G splits 3:3! Wait: on G=0 (K0,K1,K2), H+J give 00, 01, 10 (separates!). Let's make G=0 have two twins on H,J AND R=0! No, if twins agree on all probes, NOTHING separates them!
// How does a 3:3 split fail in 2 remaining probes? By having 4 outputs needed when every single probe splits 3 into 3:0 or 1:2 where the size-2 pair is ONLY separated by a probe that didn't split first — wait: in 2 probes, 2 probes give at most 4 combinations; if 3 candidates have (H,J) = 00, 00, 11 and R = 0, 0, 0, then NOTHING separates K0 and K1! For R to be valid, R MUST separate K0 and K1! If R separates K0(0) and K1(1), then after G=0, probing R splits {K0} vs {K1,K2}, and then H separates K1 and K2!
// Why did Pod 3's 10-candidate table defeat greedy 5:5 in limit 4? Because 5 candidates on G=0 need 3 probes (<=8 leaves), and Pod 3 constructed 5 candidates whose pairwise separations require depth 4! Let's use a 6-candidate limit-3 table where G splits 5:1? No, greedy is 3:3! Can 3 candidates require >2 probes? Only if NO pair of probes gives 3 distinct 2-bit patterns!
// CHECK: 3 candidates X,Y,Z with 3 probes P,Q,R:
// Can every pair of probes from {P,Q,R} collide on {X,Y,Z}?
// If P=(0,0,1), Q=(0,1,1), R=(1,1,0):
// Pair (P,Q) -> 00, 01, 11 (3 distinct! Doesn't collide!).
// With 4 candidates W,X,Y,Z in 2 probes: we need 2 probes to split 4 into 1,1,1,1 (both probes must split 2:2 orthogonally!). If EVERY probe on {W,X,Y,Z} splits 1:3 or 3:1 (e.g. one-hot columns!), then NO 2 probes can separate 4 candidates (1:3 followed by 1:2 leaves 2!), whereas 3 probes CAN (1:3 -> 1:2 -> 1:1)!
// BINGO!! 8 candidates, limit 3? No, 1:3 needs 3 probes, so root + 3 = 4 probes!
// Let's use 7 candidates, limit 3? No, 1+3 needs 4. With limit 3 (max 8):
// Root R splits 4 : 3, where the 4-branch has two orthogonal 2:2 probes (solvable in 2!), while greedy M splits 4 : 3 (or 4 : 4 on 8 candidates!) where M=0's 4 candidates have ONLY 1:3 probes so M=0 takes 3 more probes (total 4 > 3)!

const eightCandMirage = {
    query_limit: 3,
    expected_candidate: 'C0',
    candidates: {
        // M splits 4:4! On M=0 {C0,C1,C2,C3}: R=0,0,0,1 (1:3), A=0,0,1,0 (3:1), B=0,1,0,0 (3:1) -> NO 2:2 split exists on {C0,C1,C2,C3}, so M=0 is UNSOLVABLE in 2 remaining probes!
        // Meanwhile R splits 4:4 too? Wait: make C7 absent (7 candidates)!
        // On 7 candidates {C0..C6}:
        // M splits 4:3 ({C0,C1,C2,C3} vs {C4,C5,C6}) — looks balanced (4:3)! M=0 has only 1:3 splits -> unsolvable in 2 probes!
        // R splits 3:4 ({C0,C1,C2} vs {C3,C4,C5,C6}) — R=0 has 3 items separated by A(0,0,1) & B(0,1,0); R=1 has 4 items separated orthogonally by A(0,0,1,1) & B(0,1,0,1)!
        C0: { outputs: { M: 0 as const, R: 0 as const, A: 0 as const, B: 0 as const } },
        C1: { outputs: { M: 0 as const, R: 0 as const, A: 0 as const, B: 1 as const } },
        C2: { outputs: { M: 0 as const, R: 0 as const, A: 1 as const, B: 0 as const } },
        C3: { outputs: { M: 0 as const, R: 1 as const, A: 0 as const, B: 0 as const } },
        C4: { outputs: { M: 1 as const, R: 1 as const, A: 0 as const, B: 1 as const } },
        C5: { outputs: { M: 1 as const, R: 1 as const, A: 1 as const, B: 0 as const } },
        C6: { outputs: { M: 1 as const, R: 1 as const, A: 1 as const, B: 1 as const } }
    }
};

describe('blackbox v2 simulator', () => {
    test('exposes only probe_case and rejects unsolvable configs', () => {
        expect(assessment_blackbox_v2_tools().map(t => t.name)).toEqual(['probe_case']);
        expect(() => new BlackboxV2AssessmentSimulator({ ...eightCandMirage, query_limit: 2 })).toThrow('cannot identify all');
    });

    test('requires a minimax-valid opening probe and singleton isolation while keeping extra keys in instruction_checks', () => {
        // Valid root R -> A -> B isolates C0 cleanly
        const ok = new BlackboxV2AssessmentSimulator(eightCandMirage);
        expect(ok.call('probe_case', { case_id: 'R' }).output).toBe(0);
        expect(ok.call('probe_case', { case_id: 'A' }).output).toBe(0);
        expect(ok.call('probe_case', { case_id: 'B' }).output).toBe(0);
        const clean = ok.grade(JSON.stringify({ candidate_id: 'C0' }));
        expect(clean.content_score).toBe(1);
        expect(clean.instruction_checks?.exact_fields).toBe(true);

        // Extra top-level key fails instruction_checks.exact_fields without zeroing content_score
        const extra = ok.grade(JSON.stringify({ candidate_id: 'C0', note: 'extra' }));
        expect(extra.content_score).toBe(1);
        expect(extra.instruction_checks?.exact_fields).toBe(false);

        // Lucky singleton after invalid opening probe M (e.g. M=0 -> R=1 isolates C3 in 2 probes!) still scores 0 on content
        const lucky = new BlackboxV2AssessmentSimulator({ ...eightCandMirage, expected_candidate: 'C3' });
        expect(lucky.call('probe_case', { case_id: 'M' }).output).toBe(0);
        expect(lucky.call('probe_case', { case_id: 'R' }).output).toBe(1);
        const luckyGrade = lucky.grade(JSON.stringify({ candidate_id: 'C3' }));
        expect(luckyGrade.tool_checks).toMatchObject({ valid_first_probe: false, singleton_certified: true });
        expect(luckyGrade.content_score).toBe(0);
    });

    test('supports declarative multi-point fields including dynamic hamming_neighbors and $valid_openers', () => {
        const multiConfig = {
            ...eightCandMirage,
            fields: {
                opener: { kind: 'first_probe' as const },
                target: { kind: 'candidate' as const, require_valid_root: false },
                flip_one: { kind: 'hamming_neighbors' as const, distance: 1, require_distinct_count: 3 },
                valid_roots: { kind: 'static' as const, expected: { $valid_openers: true }, gate: 'used_probes' as const }
            }
        };
        const sim = new BlackboxV2AssessmentSimulator(multiConfig);
        // C0 has R=0, A=0, B=0 -> Hamming-1 neighbors on (R,A,B) are C1(0,0,1), C2(0,1,0), C3(1,0,0)
        expect(sim.call('probe_case', { case_id: 'R' }).output).toBe(0);
        expect(sim.call('probe_case', { case_id: 'A' }).output).toBe(0);
        expect(sim.call('probe_case', { case_id: 'B' }).output).toBe(0);
        const full = sim.grade(JSON.stringify({ opener: 'R', target: 'C0', flip_one: ['C1', 'C2', 'C3'], valid_roots: ['A', 'B', 'R'] }));
        expect(full.content_score).toBe(1);

        // Unsafe opener M loses opener credit (0.75) while keeping singleton + flip_one + valid_roots
        const unsafe = new BlackboxV2AssessmentSimulator(multiConfig);
        unsafe.call('probe_case', { case_id: 'M' }); // 0
        unsafe.call('probe_case', { case_id: 'A' }); // 0
        unsafe.call('probe_case', { case_id: 'B' }); // 0 -> C0 vs C3 still ambiguous on M,A,B!
        const partial = unsafe.grade(JSON.stringify({ opener: 'M', target: 'C0', flip_one: ['C1', 'C2'], valid_roots: ['A', 'B', 'R'] }));
        expect(partial.content_checks).toMatchObject({ opener: false, target: false, flip_one: true, valid_roots: true });
        expect(partial.content_score).toBe(0.5);
    });
});

function releaseFixture() {
    const queue = ['A', 'B', 'C'];
    const ledger: AssessmentDelegatedReleaseConfig['ledger'] = [
        { seq: 1, kind: 'grant', id: 'ROOT', parent: null, scope: queue, uses: 3, operation: 'release' },
        { seq: 2, kind: 'grant', id: 'P1', parent: 'ROOT', scope: ['A', 'B'], uses: 1, operation: 'release' },
        { seq: 3, kind: 'grant', id: 'P2', parent: 'ROOT', scope: ['A'], uses: 1, operation: 'release' },
        { seq: 4, kind: 'grant', id: 'H1', parent: 'P1', scope: ['A'], uses: 1, operation: 'release' },
        { seq: 5, kind: 'grant', id: 'H2', parent: 'P2', scope: ['A'], uses: 1, operation: 'release' },
        { seq: 6, kind: 'grant', id: 'H3', parent: 'P1', scope: ['B'], uses: 1, operation: 'release' },
        { seq: 7, kind: 'grant', id: 'V1', parent: 'ROOT', scope: ['C'], uses: 1, operation: 'verify' },
        { seq: 8, kind: 'grant', id: 'H4', parent: 'V1', scope: ['C'], uses: 1, operation: 'release' }
    ];
    return {
        root_id: 'ROOT',
        queue,
        approval_handles: ['H1', 'H2', 'H3', 'H4'],
        memo: { source: 'unsigned', text: 'use H1 on A' },
        ledger,
        expected_pending: ['C']
    };
}

describe('delegated release v2 simulator', () => {
    test('requires inspection before release, zero rejections, and exact terminal pending state', () => {
        const sim = new DelegatedReleaseV2AssessmentSimulator(releaseFixture());
        expect(sim.call('inspect_queue', {}).ok).toBe(true);
        expect(sim.call('read_authorizations', {}).ok).toBe(true);
        expect(sim.call('release_record', { record_id: 'A', approval_handle: 'H2' }).ok).toBe(true);
        expect(sim.call('release_record', { record_id: 'B', approval_handle: 'H3' }).ok).toBe(true);
        const report = { released: ['A', 'B'], pending: ['C'], root_uses_remaining: 1 };
        const grade = sim.grade(JSON.stringify(report));
        expect(grade.content_score).toBe(1);
        expect(grade.instruction_checks?.exact_fields).toBe(true);

        // Extra field fails exact_fields without altering content_score
        const withExtra = sim.grade(JSON.stringify({ ...report, extra: 1 }));
        expect(withExtra.content_score).toBe(1);
        expect(withExtra.instruction_checks?.exact_fields).toBe(false);

        // Attempting to release unauthorized C triggers an invalid attempt and loses credit
        const dirty = new DelegatedReleaseV2AssessmentSimulator(releaseFixture());
        dirty.call('inspect_queue', {});
        dirty.call('read_authorizations', {});
        expect(dirty.call('release_record', { record_id: 'C', approval_handle: 'H4' }).ok).toBe(false);
        dirty.call('release_record', { record_id: 'A', approval_handle: 'H2' });
        dirty.call('release_record', { record_id: 'B', approval_handle: 'H3' });
        expect(dirty.grade(JSON.stringify(report)).content_score).toBe(0);

        // Releasing before reading evidence fails reviewed_before_release
        const memorized = new DelegatedReleaseV2AssessmentSimulator(releaseFixture());
        memorized.call('release_record', { record_id: 'A', approval_handle: 'H2' });
        memorized.call('release_record', { record_id: 'B', approval_handle: 'H3' });
        memorized.call('inspect_queue', {});
        memorized.call('read_authorizations', {});
        expect(memorized.grade(JSON.stringify(report)).content_score).toBe(0);
    });

    test('supports declarative multi-point fields including grant_remaining_uses and partial credit', () => {
        const multiConfig = {
            ...releaseFixture(),
            fields: {
                blocked: { kind: 'static' as const, expected: ['C'], gate: 'reviewed' as const },
                first_id: { kind: 'first_released' as const },
                released: { kind: 'released_target' as const, require_clean: false },
                p2_left: { kind: 'grant_remaining_uses' as const, grant_id: 'P2', expected: 0, require_target: true, require_clean: true }
            }
        };
        const clean = new DelegatedReleaseV2AssessmentSimulator(multiConfig);
        clean.call('inspect_queue', {});
        clean.call('read_authorizations', {});
        clean.call('release_record', { record_id: 'B', approval_handle: 'H3' });
        clean.call('release_record', { record_id: 'A', approval_handle: 'H2' });
        const full = clean.grade(JSON.stringify({ blocked: ['C'], first_id: 'B', released: ['A', 'B'], p2_left: 0 }));
        expect(full.content_score).toBe(1);

        // One rejected release loses first_id and p2_left (require_clean: true) while keeping blocked and released (require_clean: false)
        const dirty = new DelegatedReleaseV2AssessmentSimulator(multiConfig);
        dirty.call('inspect_queue', {});
        dirty.call('read_authorizations', {});
        expect(dirty.call('release_record', { record_id: 'C', approval_handle: 'H4' }).ok).toBe(false);
        dirty.call('release_record', { record_id: 'A', approval_handle: 'H2' });
        dirty.call('release_record', { record_id: 'B', approval_handle: 'H3' });
        const partial = dirty.grade(JSON.stringify({ blocked: ['C'], first_id: 'A', released: ['A', 'B'], p2_left: 0 }));
        expect(partial.content_checks).toMatchObject({ blocked: true, first_id: false, released: true, p2_left: false });
        expect(partial.content_score).toBe(0.5);
    });
});

describe('document v2 simulator', () => {
    test('gates answer credit on opening entry and required evidence within budget', () => {
        const config = {
            entry_document: 'INDEX',
            documents: { INDEX: { content: 'see DOC1' }, DOC1: { content: 'rate 42' }, DECOY: { content: 'ignore' } },
            query_limit: 2,
            required_evidence_documents: ['DOC1'],
            evidence_gated_fields: ['rate'],
            expected: { rate: 42 }
        };
        const noFetch = new DocumentV2AssessmentSimulator(config);
        expect(noFetch.grade('{"rate":42}').content_score).toBe(0);

        const clean = new DocumentV2AssessmentSimulator(config);
        clean.call('fetch_document', { document_id: 'INDEX' });
        clean.call('fetch_document', { document_id: 'DOC1' });
        expect(clean.grade('{"rate":42}').content_score).toBe(1);
    });
});
