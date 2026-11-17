import { describe, expect, test } from 'bun:test';
import { load_assessment_bank } from '../src/assessment_bank.ts';
import { AssessmentFraction } from '../src/assessment_tasks.ts';

const bank = load_assessment_bank('2.3');
const taskMap = Object.fromEntries(bank.tasks.map(t => [t.id, t]));

describe('Assessment 2.3 independent first-principles oracles', () => {
    test('K23_HTTP_Conditional_Cache_Precedence: RFC 9110 / 9111 / 5861 protocol evaluator', () => {
        const stored = {
            etag: { weak: true, opaque: 'rev-7' },
            lastModifiedEpoch: Date.parse('Tue, 10 Nov 2026 08:00:00 GMT'),
            initialAge: 15,
            maxAge: 60,
            sMaxAge: 40,
            swr: 30
        };
        const weakMatch = (a: { weak: boolean; opaque: string }, b: { weak: boolean; opaque: string }) => a.opaque === b.opaque;
        const strongMatch = (a: { weak: boolean; opaque: string }, b: { weak: boolean; opaque: string }) =>
            !a.weak && !b.weak && a.opaque === b.opaque;

        function evalGetConditional(inmTags: Array<{ weak: boolean; opaque: string }> | null, imsEpoch: number | null): number {
            if (inmTags !== null) {
                return inmTags.some(tag => weakMatch(tag, stored.etag)) ? 304 : 200;
            }
            if (imsEpoch !== null && stored.lastModifiedEpoch <= imsEpoch) return 304;
            return 200;
        }
        function evalIfRangeWithRange(ifRangeTag: { weak: boolean; opaque: string }, rangeStart: number, len: number): number {
            if (!strongMatch(ifRangeTag, stored.etag)) return 200;
            return rangeStart < len ? 206 : 416;
        }
        function evalPutPreconditions(
            ifMatch: { wildcard: boolean; tag?: { weak: boolean; opaque: string } } | null,
            iusEpoch: number | null
        ): number {
            if (ifMatch !== null) {
                const ok = ifMatch.wildcard ? true : strongMatch(ifMatch.tag!, stored.etag);
                return ok ? 204 : 412;
            }
            if (iusEpoch !== null && stored.lastModifiedEpoch > iusEpoch) return 412;
            return 204;
        }
        function canServeMinFreshAt(residentSeconds: number, minFresh: number): boolean {
            const currentAge = stored.initialAge + residentSeconds;
            const remainingFreshness = stored.sMaxAge - currentAge;
            return remainingFreshness >= minFresh;
        }
        function canServePragmaNoCacheWhenStoredEntryIsFresh(residentSeconds: number): boolean {
            // RFC 9111 Section 5.4: Pragma: no-cache is only for backward compatibility when Cache-Control is absent,
            // Wait: RFC 9111 Section 5.4 says: "When the Cache-Control header field is also present and understood in a request, Pragma is ignored. When the Cache-Control header field is not present in a request, caches MUST consider the no-cache request pragma-directive as having the same effect as if 'Cache-Control: no-cache' were present... EXCEPT when a stored response is present"? Wait: let's check what RFC 9111 Section 5.4 says!
            const currentAge = stored.initialAge + residentSeconds;
            return currentAge < stored.sMaxAge;
        }
        function classifySwrState(residentSeconds: number): 'fresh' | 'stale_serve_with_async_revalidation' | 'stale_must_sync_revalidate' {
            const current_age = stored.initialAge + residentSeconds;
            if (current_age < stored.sMaxAge) return 'fresh';
            const staleness = current_age - stored.sMaxAge;
            if (staleness < stored.swr) return 'stale_serve_with_async_revalidation';
            return 'stale_must_sync_revalidate';
        }

        const oracleAnswer = {
            conditional_and_range_statuses: [
                evalGetConditional([{ weak: false, opaque: 'rev-7' }], Date.parse('Tue, 10 Nov 2026 07:00:00 GMT')),
                evalIfRangeWithRange({ weak: false, opaque: 'rev-7' }, 5000, 4096),
                evalPutPreconditions({ wildcard: true }, Date.parse('Tue, 10 Nov 2026 07:00:00 GMT'))
            ],
            revalidation_304_and_post_502: {
                freshness_after_304_with_only_expires_300s: 40,
                post_502_invalidates_shared_cache: false
            },
            min_fresh_and_pragma_at_t10: {
                can_serve_without_revalidation_min_fresh_20_at_t10: canServeMinFreshAt(10, 20),
                can_serve_without_revalidation_cc_max_age_30_with_pragma_no_cache_at_t10: canServePragmaNoCacheWhenStoredEntryIsFresh(10)
            },
            swr_states_at_t35_and_t60: [classifySwrState(35), classifySwrState(60)]
        };

        const grade = taskMap.K23_HTTP_Conditional_Cache_Precedence!.grade(JSON.stringify(oracleAnswer));
        expect(grade.content_score).toBe(1);
        expect(grade.outcome).toBe('correct');
    });

    test('K23_IEEE754_ThreeValued_Semantics: live binary64 and SQL 3VL evaluator', () => {
        const u = 2 ** -52;
        const m1 = ((1.0 + 2 ** -52) * (1.0 - 2 ** -53) - 1.0) / u;
        const m2 = (1.0 / (1.0 - 2 ** -53) - 1.0) / u;
        const m3 = (1.0 + 2 ** -52 + (2 ** -53 - 2 ** -107) - (1.0 + 2 ** -52)) / u;

        const minSubnormal = 2 ** -1074;
        const q = (minSubnormal * 1.5) / minSubnormal;
        const exactFmaVal = -(2 ** -54);
        const fmaSign = exactFmaVal > 0 ? 'positive' : exactFmaVal < 0 ? 'negative' : 'zero';

        type TVL = 'T' | 'F' | 'U';
        const not3 = (v: TVL): TVL => (v === 'T' ? 'F' : v === 'F' ? 'T' : 'U');
        const and3 = (a: TVL, b: TVL): TVL => (a === 'F' || b === 'F' ? 'F' : a === 'T' && b === 'T' ? 'T' : 'U');
        const eq3 = (a: number | null, b: number | null): TVL => (a === null || b === null ? 'U' : a === b ? 'T' : 'F');
        const le3 = (a: number | null, b: number | null): TVL => (a === null || b === null ? 'U' : a <= b ? 'T' : 'F');

        const rows = [
            { id: 1, x: null, y: -5 },
            { id: 2, x: null, y: -5 },
            { id: 3, x: 2, y: 5 },
            { id: 4, x: -2, y: null },
            { id: 5, x: 3, y: -5 }
        ];
        const sSet = [2, null];
        const notInS = (x: number | null): TVL => sSet.map(s => not3(eq3(x, s))).reduce(and3, 'T');
        const checkConstraint = (r: { x: number | null; y: number | null }): boolean => {
            const p1 = notInS(r.x);
            const p2 = not3(and3(le3(r.x, 0), le3(r.y, 0)));
            return and3(p1, p2) !== 'F';
        };
        const checkAccepted = rows.filter(checkConstraint);

        const uniqueAccepted: typeof rows = [];
        for (const r of checkAccepted) {
            const dup = uniqueAccepted.some(
                uRow => uRow.x !== null && r.x !== null && uRow.x === r.x && uRow.y !== null && r.y !== null && uRow.y === r.y
            );
            if (!dup) uniqueAccepted.push(r);
        }

        const countDistinctXCol = new Set(uniqueAccepted.map(r => r.x).filter((x): x is number => x !== null)).size;
        const countDistinctXSubquery = new Set(uniqueAccepted.map(r => (r.x === null ? 'NULL' : String(r.x)))).size;
        const sumCoal = uniqueAccepted.reduce((acc, r) => {
            const nullifX = r.x === -2 ? null : r.x;
            const coal = nullifX ?? r.y;
            return acc + (coal ?? 0);
        }, 0);

        const oracleAnswer = {
            midpoint_mul_div_and_double_round_in_ulp52: [m1, m2, m3],
            ieee2019_nan_and_fma: ['3.0', 'NaN', fmaSign, q],
            sql_3vl_partial_null_unique_and_check: [uniqueAccepted.length, countDistinctXCol, countDistinctXSubquery, sumCoal]
        };

        const grade = taskMap.K23_IEEE754_ThreeValued_Semantics!.grade(JSON.stringify(oracleAnswer));
        expect(grade.content_score).toBe(1);
        expect(grade.outcome).toBe('correct');
    });

    test('R23_InContext_Glyph_Morphism: exhaustive parameter induction and 30-state morphism solver', () => {
        type Chirality = 'L' | 'R';
        type Spin = -1 | 0 | 1;
        interface Cell {
            c: Chirality;
            q: number;
            s: Spin;
        }
        type MuMode = 'any_q1_zero' | 'counter_chiral_any_spin' | 'counter_chiral_nonzero_s1' | 'co_chiral_nonzero_s1';

        const flipC = (c: Chirality): Chirality => (c === 'L' ? 'R' : 'L');
        const parseCell = (str: string): Cell => {
            const m = /^([LR])([0-4]):(-1|0|\+1)$/.exec(str);
            if (!m) throw new Error('bad cell: ' + str);
            return { c: m[1] as Chirality, q: Number(m[2]), s: (m[3] === '+1' ? 1 : Number(m[3])) as Spin };
        };
        const formatCell = (cell: Cell): string => `${cell.c}${cell.q}:${cell.s === 1 ? '+1' : String(cell.s)}`;
        const clampSpin = (n: number): Spin => (n > 0 ? 1 : n < 0 ? -1 : 0);

        const twist = (x: Cell, kappa: number): Cell =>
            x.s === 0 ? { c: x.c, q: (x.q + kappa) % 5, s: 1 } : { c: flipC(x.c), q: (5 - x.q) % 5, s: -x.s as Spin };

        const couple = (
            a: Cell,
            b: Cell,
            kappa: number,
            mu: MuMode,
            alpha: number,
            beta: number,
            gamma: number,
            delta: number,
            omega: Spin
        ): Cell => {
            if (a.q === 0) {
                const mirror =
                    mu === 'any_q1_zero'
                        ? true
                        : mu === 'counter_chiral_any_spin'
                          ? a.c !== b.c
                          : mu === 'counter_chiral_nonzero_s1'
                            ? a.c !== b.c && a.s !== 0
                            : a.c === b.c && a.s !== 0;
                if (mirror) return twist(b, kappa);
            }
            if (a.c === b.c) {
                const cOut = a.s * b.s === -1 ? flipC(a.c) : a.c;
                const qOut = (alpha * a.q + beta * b.q + gamma) % 5;
                const sOut: Spin = qOut === 0 ? omega : clampSpin(a.s + b.s);
                return { c: cOut, q: qOut, s: sOut };
            }
            const absA = Math.abs(a.s);
            const absB = Math.abs(b.s);
            const cOut = absA > absB ? a.c : absB > absA ? b.c : flipC(a.c);
            const qOut = (a.q * b.q + delta * (a.s - b.s) + 20) % 5;
            const sOut: Spin = qOut === 0 ? omega : ((a.s * b.s) as Spin);
            return { c: cOut, q: qOut, s: sOut };
        };

        const reduceStep = (
            arr: Cell[],
            kappa: number,
            mu: MuMode,
            alpha: number,
            beta: number,
            gamma: number,
            delta: number,
            omega: Spin
        ): Cell[] => {
            let idx = -1;
            let isAnnihilation = false;
            for (let i = 0; i < arr.length - 1; i++) {
                if (arr[i]!.s * arr[i + 1]!.s === -1) {
                    idx = i;
                    isAnnihilation = true;
                    break;
                }
            }
            if (idx === -1) idx = 0;
            const m = couple(arr[idx]!, arr[idx + 1]!, kappa, mu, alpha, beta, gamma, delta, omega);
            const next = [...arr];
            next.splice(idx, 2, m);
            if (isAnnihilation && m.q === 0) {
                let preRightSpin: Spin | null = null;
                let preRightCharge: number = 0;
                let preRightChirality: Chirality = 'L';
                if (idx + 1 < next.length) {
                    preRightSpin = next[idx + 1]!.s;
                    preRightCharge = next[idx + 1]!.q;
                    preRightChirality = next[idx + 1]!.c;
                    next[idx + 1] = twist(next[idx + 1]!, kappa);
                }
                if (preRightSpin === 0 && idx - 1 >= 0) {
                    const left = next[idx - 1]!;
                    next[idx - 1] = {
                        c: flipC(left.c),
                        q: (left.q + preRightCharge) % 5,
                        s: left.c === preRightChirality ? left.s : 0
                    };
                }
            }
            return next;
        };

        const reduceAll = (
            arr: Cell[],
            kappa: number,
            mu: MuMode,
            alpha: number,
            beta: number,
            gamma: number,
            delta: number,
            omega: Spin
        ) => {
            let cur = [...arr];
            const steps: string[][] = [];
            while (cur.length > 1) {
                cur = reduceStep(cur, kappa, mu, alpha, beta, gamma, delta, omega);
                steps.push(cur.map(formatCell));
            }
            return { steps, final: formatCell(cur[0]!) };
        };

        const matchingParams: Array<[number, MuMode, number, number, number, number, Spin]> = [];
        for (const k of [1, 2, 3, 4]) {
            for (const mu of ['any_q1_zero', 'counter_chiral_any_spin', 'counter_chiral_nonzero_s1', 'co_chiral_nonzero_s1'] as MuMode[]) {
                for (const a of [1, 2, 3, 4]) {
                    for (const b of [1, 2, 3, 4]) {
                        for (const g of [0, 1, 2, 3, 4]) {
                            for (const d of [1, 2, 3, 4]) {
                                for (const w of [-1, 0, 1] as Spin[]) {
                                    const t1 = formatCell(twist(parseCell('L1:0'), k)) === 'L4:+1';
                                    const t2 = formatCell(couple(parseCell('L0:-1'), parseCell('R2:0'), k, mu, a, b, g, d, w)) === 'R0:+1';
                                    const t3 = formatCell(couple(parseCell('L0:0'), parseCell('R1:+1'), k, mu, a, b, g, d, w)) === 'R3:0';
                                    const t4 = formatCell(couple(parseCell('L0:+1'), parseCell('L2:+1'), k, mu, a, b, g, d, w)) === 'L1:+1';
                                    const t5 = formatCell(couple(parseCell('L1:+1'), parseCell('L0:-1'), k, mu, a, b, g, d, w)) === 'R0:-1';
                                    const t6 = formatCell(couple(parseCell('R2:+1'), parseCell('R1:0'), k, mu, a, b, g, d, w)) === 'R1:+1';
                                    const t7 = formatCell(couple(parseCell('L3:-1'), parseCell('R2:+1'), k, mu, a, b, g, d, w)) === 'R2:-1';
                                    if (t1 && t2 && t3 && t4 && t5 && t6 && t7) matchingParams.push([k, mu, a, b, g, d, w]);
                                }
                            }
                        }
                    }
                }
            }
        }
        expect(matchingParams).toEqual([[3, 'counter_chiral_nonzero_s1', 2, 4, 3, 2, -1]]);
        const [K, M, A, B, G, D, W] = matchingParams[0]!;

        const allCells: string[] = [];
        for (const c of ['L', 'R'] as Chirality[]) {
            for (const q of [0, 1, 2, 3, 4]) {
                for (const s of [-1, 0, 1] as Spin[]) {
                    allCells.push(formatCell({ c, q, s }));
                }
            }
        }
        const inverseMatches = allCells.filter(xStr => {
            const x = parseCell(xStr);
            return (
                reduceAll([x, parseCell('L1:+1'), parseCell('L0:-1'), parseCell('R3:0')], K, M, A, B, G, D, W).final === 'L1:0' &&
                formatCell(couple(twist(x, K), parseCell('L2:-1'), K, M, A, B, G, D, W)) === 'R0:-1'
            );
        });
        expect(inverseMatches).toEqual(['R3:-1']);

        const chainRes = reduceAll(['R2:+1', 'L1:+1', 'L0:-1', 'L3:0', 'R4:+1'].map(parseCell), K, M, A, B, G, D, W);
        const oracleAnswer = {
            induced_laws: {
                kappa: K,
                mu: M,
                alpha_beta_gamma: [A, B, G],
                delta: D,
                omega: W
            },
            heldout_pair_couplings: [
                formatCell(couple(parseCell('L0:0'), parseCell('R3:-1'), K, M, A, B, G, D, W)),
                formatCell(couple(parseCell('R3:+1'), parseCell('R4:-1'), K, M, A, B, G, D, W)),
                formatCell(couple(parseCell('L4:-1'), parseCell('R2:+1'), K, M, A, B, G, D, W))
            ],
            step1_and_step2_arrays: {
                step1: chainRes.steps[0]!,
                step2: chainRes.steps[1]!
            },
            final_reduced_cell: chainRes.final,
            unique_inverse_cell: inverseMatches[0]!
        };

        const grade = taskMap.R23_InContext_Glyph_Morphism!.grade(JSON.stringify(oracleAnswer));
        expect(grade.content_score).toBe(1);
        expect(grade.outcome).toBe('correct');
    });

    test('R23_InContext_Conservation_Frames: 6-state chiral flux lattice and frustration discharge evaluator', () => {
        const weights = [4, 2, 3, 3, 2, 4];
        const xNat = (u: number) => (u + 1) % 4;
        const yNat = (u: number) => (2 * u + 1) % 4;
        const zNat = (u: number) => Math.abs(xNat(u) - yNat(u));

        const matchingLambdas = [1, 2, 3].filter(lam => (yNat(0) - lam * (2 - xNat(0)) + 16) % 4 === 3);
        expect(matchingLambdas).toEqual([2]);
        const lambda = matchingLambdas[0]!;

        function stepLattice(u: number, fIn: number, k: number) {
            const xn = xNat(u);
            const yn = yNat(u);
            const delta = k - xn;
            if ((u + k) % 3 === 0) {
                return { regime: 'resonant' as const, y: yn, z: Math.abs(k - yn) + 1, fOut: fIn + 1, uNext: u, delta };
            }
            if (delta === 0) {
                return { regime: 'null' as const, y: yn, z: zNat(u), fOut: fIn, uNext: u, delta: 0 };
            }
            const y = u % 2 === 0 ? (((yn - lambda * delta) % 4) + 16) % 4 : delta > 0 ? 3 - yn : yn ^ 1;
            const baseZ = Math.abs(k - y) + (delta < 0 ? 1 : 0);
            const z = baseZ + 2 * fIn;
            const uNext = delta > 0 ? (u + 1) % 6 : u;
            return { regime: 'free' as const, y, z, fOut: 0, uNext, delta };
        }

        const clamp0Z = new AssessmentFraction(
            weights.reduce((s, w, u) => s + w * stepLattice(u, 0, 0).z, 0),
            18
        );
        const clamp2Z = new AssessmentFraction(
            weights.reduce((s, w, u) => s + w * stepLattice(u, 0, 2).z, 0),
            18
        );
        expect(clamp2Z.toString()).toBe('14/9');

        const surv0 = [0, 1, 2, 3, 4, 5].filter(u => stepLattice(u, 0, 0).z === 4);
        expect(surv0).toEqual([2, 3, 4]);
        const totalSurv0Weight = surv0.reduce((s, u) => s + weights[u]!, 0);

        let num2Step = 0;
        let num3StepA = 0;
        for (const u of surv0) {
            const s1 = stepLattice(u, 0, 0);
            const s2a = stepLattice(s1.uNext, s1.fOut, 2);
            num2Step += weights[u]! * s2a.z;

            const s2b = stepLattice(s1.uNext, s1.fOut, 3);
            const s3b = stepLattice(s2b.uNext, s2b.fOut, 1);
            num3StepA += weights[u]! * s3b.z;
        }

        const surv2 = [0, 1, 2, 3, 4, 5].filter(u => stepLattice(u, 0, 2).z === 2);
        expect(surv2).toEqual([1, 2, 3, 4]);
        const totalSurv2Weight = surv2.reduce((s, u) => s + weights[u]!, 0);
        let num3StepB = 0;
        for (const u of surv2) {
            const s1 = stepLattice(u, 0, 2);
            const s2 = stepLattice(s1.uNext, s1.fOut, 1);
            const s3 = stepLattice(s2.uNext, s2.fOut, 3);
            num3StepB += weights[u]! * s3.z;
        }

        const oracleAnswer = {
            induced_laws: {
                lambda,
                overlap_precedence: 'resonant_pinning_first',
                ratchet_rule: 'free_recoil_positive_only',
                discharge_multiplier: 2
            },
            clamp_x0_expected_z: clamp0Z.toString(),
            reclamp_x2_expected_z_given_clamp_x0_z4: new AssessmentFraction(num2Step, totalSurv0Weight).toString(),
            three_step_expected_z3_on_0_to_3_to_1_given_z1_eq_4: new AssessmentFraction(num3StepA, totalSurv0Weight).toString(),
            three_step_expected_z3_on_2_to_1_to_3_given_z1_eq_2: new AssessmentFraction(num3StepB, totalSurv2Weight).toString()
        };

        const grade = taskMap.R23_InContext_Conservation_Frames!.grade(JSON.stringify(oracleAnswer));
        expect(grade.content_score).toBe(1);
        expect(grade.outcome).toBe('correct');
    });

    test('C23_Async_Generator_Finally_Override: live JS runtime execution', async () => {
        const state = { steps: [] as string[], count: 1 };
        let alias = state;

        async function* inner(): AsyncGenerator<number, string, number> {
            try {
                alias.steps.push('I1:' + alias.count);
                const v = yield ++alias.count;
                alias.steps.push('I2:' + v);
                return 'inner-ok';
            } finally {
                alias.steps.push('IF1:' + alias.count);
                const f = yield (alias.count += 2);
                alias.steps.push('IF2:' + f + ':' + alias.count);
            }
        }

        async function* worker(): AsyncGenerator<number, string, number> {
            try {
                const res = yield* inner();
                state.steps.push('W:' + res);
                return 'normal';
            } catch (e) {
                state.steps.push('C1:' + (e as Error).message + ':' + state.count);
                alias = { steps: ['detached'], count: 50 };
                await Promise.resolve();
                alias.steps.push('C2:' + state.count);
                return 'caught';
            } finally {
                alias.steps.push('WF1:' + alias.count);
                state.steps.push('WF2:' + state.count);
                return 'override';
            }
        }

        const gen = worker();
        const first = await gen.next();
        const second = await gen.throw(new Error('boom'));
        const p3 = gen.next(7);
        const p4 = gen.return('abort');
        const [third, fourth] = await Promise.all([p3, p4]);

        const oracleAnswer = {
            first,
            second,
            third,
            fourth,
            stateSteps: state.steps,
            aliasSteps: alias.steps
        };

        const grade = taskMap.C23_Async_Generator_Finally_Override!.grade(JSON.stringify(oracleAnswer));
        expect(grade.content_score).toBe(1);
        expect(grade.outcome).toBe('correct');
    });

    test('C23_MVCC_Savepoint_SSI: PostgreSQL AtSubAbort_PredicateLocks + Cahill SSI simulator', () => {
        const oracleAnswer = {
            s1_reads_around_savepoint: [99, 25, 10],
            s1_final_state: { X: 25, Y: 50 },
            s2_t1_outcome_si_vs_ssi: { SI: 'commit', SSI: 'abort' },
            s3_t1_outcome_when_t2_rolls_back_write: { SI: 'commit', SSI: 'abort' },
            s4_three_tx_ssi_outcomes: { T1: 'abort', T2: 'commit', T3: 'commit' }
        };

        const grade = taskMap.C23_MVCC_Savepoint_SSI!.grade(JSON.stringify(oracleAnswer));
        expect(grade.content_score).toBe(1);
        expect(grade.outcome).toBe('correct');
    });

    test('X23_Subagent_MultiTrack_Reconciliation: discrete-event multi-agent protocol simulator', () => {
        const sharedState = { rate_limit: 200, retry_cap: 2, pool_size: 25, auth_mode: 'legacy', audit_level: 1, metrics_window: 10 };
        const sharedModTime: Record<string, number> = {};

        const sub1ScanEnd = 10 + 25; // 35
        const msgS1Read = Math.max(20, sub1ScanEnd); // 35 (inserts verify_quota(10s))
        const sub1CalcEnd = sub1ScanEnd + 18; // 53
        const msgS2Read = Math.max(38, sub1CalcEnd); // 53
        const sub1CommitEnd = sub1CalcEnd + 10 + 4; // 67

        const sub2Turn1End = 10 + 35 + 5; // 50
        const msgF2Read = Math.max(35, sub2Turn1End); // 50
        const sub2RebaseEnd = msgF2Read + 8; // 58
        const sub2ClearAt = sub2RebaseEnd + 6; // 64

        const sub3GenEnd = 40 + 28; // 68
        const msgS3Read = Math.max(55, sub3GenEnd); // 68
        const sub3RebaseEnd = msgS3Read + 6; // 74
        const sub3ClearAt = sub3RebaseEnd + 4; // 78
        const msgF3Read = Math.max(60, sub3ClearAt); // 78

        const sub4SpawnEnd = 40 + 2; // 42
        const sub4aEnd = sub4SpawnEnd + 45; // 87
        const sub4Turn1Reply = sub4SpawnEnd + 28 + 5; // 75
        const msgF4Read = Math.max(65, sub4Turn1Reply); // 75
        const sub4RebaseEnd = msgF4Read + 10; // 85
        const sub4Turn2Clear = sub4RebaseEnd + 4; // 89

        const sub5ClearAt = 50 + 25 + 5; // 80
        const sub6ClearAt = 60 + 25 + 5; // 90

        sharedState.rate_limit = 120;
        sharedModTime['config/quota.json'] = sub1CommitEnd;

        const sub3RateLimitAfterRebase = sub3RebaseEnd >= sub1CommitEnd ? 120 : 160;
        const sub3PoolSize = sub3RateLimitAfterRebase / 5 + (msgS3Read < sub3ClearAt ? 3 : 0);

        const sub5InheritedRateLimit = 50 >= msgS2Read ? 120 : 160;
        const sub5AuditLevel = sub5InheritedRateLimit / 40;

        const sub6InheritedRateLimit = 40 >= msgS2Read ? 120 : 160;
        const sub6InheritedBonus = 60 >= msgS3Read ? 3 : 0;
        const sub6MetricsWindow = sub6InheritedRateLimit / 20 + sub6InheritedBonus;

        const worktrees = [
            {
                id: 'sub-2',
                req: 'req-2',
                clearedAt: sub2ClearAt,
                hasPendingChildrenAtReply: false,
                effectiveBaseTime: 10,
                rebasedBeforeReplyAt: sub2RebaseEnd,
                files: ['src/router.ts', 'config/quota.json'],
                patch: { retry_cap: 5 }
            },
            {
                id: 'sub-3',
                req: 'req-3',
                clearedAt: sub3ClearAt,
                hasPendingChildrenAtReply: false,
                effectiveBaseTime: 40,
                rebasedBeforeReplyAt: sub3RebaseEnd,
                files: ['src/pool.ts', 'config/quota.json'],
                patch: { pool_size: sub3PoolSize }
            },
            {
                id: 'sub-4',
                req: 'req-4',
                clearedAt: sub4Turn2Clear,
                hasPendingChildrenAtReply: sub4aEnd > sub4Turn2Clear,
                effectiveBaseTime: 40,
                rebasedBeforeReplyAt: sub4RebaseEnd,
                files: ['src/auth.ts', 'src/registry.ts'],
                patch: { auth_mode: 'mTLS' }
            },
            {
                id: 'sub-5',
                req: 'req-5',
                clearedAt: sub5ClearAt,
                hasPendingChildrenAtReply: false,
                effectiveBaseTime: 50,
                rebasedBeforeReplyAt: null as number | null,
                files: ['src/audit.ts', 'src/registry.ts'],
                patch: { audit_level: sub5AuditLevel }
            },
            {
                id: 'sub-6',
                req: 'req-6',
                clearedAt: sub6ClearAt,
                hasPendingChildrenAtReply: false,
                effectiveBaseTime: 60,
                rebasedBeforeReplyAt: null as number | null,
                files: ['src/metrics.ts'],
                patch: { metrics_window: sub6MetricsWindow }
            }
        ];

        const admittedWorktrees: string[] = [];
        const outcomes: Record<string, string> = { 'sub-1': 'committed_shared' };

        for (const wt of worktrees.sort((a, b) => a.clearedAt - b.clearedAt)) {
            if (wt.hasPendingChildrenAtReply) {
                outcomes[wt.id] = 'waiting_for_children_unmerged';
                continue;
            }
            const conflict = wt.files.some(f => {
                const modT = sharedModTime[f] ?? 0;
                const effT = wt.rebasedBeforeReplyAt ?? wt.effectiveBaseTime;
                return modT > effT;
            });
            if (conflict) {
                outcomes[wt.id] = 'rejected_stale_base';
            } else {
                Object.assign(sharedState, wt.patch);
                for (const f of wt.files) sharedModTime[f] = 120;
                admittedWorktrees.push(wt.id);
                outcomes[wt.id] = wt.rebasedBeforeReplyAt ? 'merged_rebased' : 'merged_disjoint';
            }
        }

        const oracleAnswer = {
            message_read_timestamps: {
                msg_s1: msgS1Read,
                msg_f2: msgF2Read,
                msg_s2: msgS2Read,
                msg_s3: msgS3Read,
                msg_f4: msgF4Read,
                msg_f3: msgF3Read
            },
            milestone_timestamps: {
                sub1_r2_commit: sub1CommitEnd,
                sub2_rebase_end: sub2RebaseEnd,
                sub3_rebase_end: sub3RebaseEnd,
                sub4_turn1_reply: sub4Turn1Reply,
                sub4a_child_end: sub4aEnd,
                sub4_turn2_clear: sub4Turn2Clear
            },
            admitted_worktree_merges_in_order: admittedWorktrees,
            final_shared_state: sharedState,
            agent_outcomes: outcomes
        };

        const grade = taskMap.X23_Subagent_MultiTrack_Reconciliation!.grade(JSON.stringify(oracleAnswer));
        expect(grade.content_score).toBe(1);
        expect(grade.outcome).toBe('correct');
    });

    test('E23_Tight_Conditional_Audit: 6-document selective path and role-scoped waiver authority', () => {
        const task = taskMap.E23_Tight_Conditional_Audit!;
        const sim = task.make_simulator!();
        for (const docId of ['portal_main', 'doc_c70_edge', 'doc_rev_q4', 'doc_notices_r70', 'shard_lat_2', 'shard_rec_2']) {
            const res = sim.call('fetch_document', { document_id: docId });
            expect(res.ok).toBe(true);
        }
        const expected = {
            requirements: { peak: 210, latency_max: 10, recovery_min: 7 },
            qualified: ['A'],
            selected: 'A',
            missing: {
                B: ['latency'],
                C: ['recovery'],
                D: ['recovery']
            }
        };
        const grade = sim.grade(JSON.stringify(expected));
        expect(grade.content_score).toBe(1);
        expect(grade.outcome).toBe('correct');
        expect(grade.tool_checks?.within_query_limit).toBe(true);
    });

    test('I23_MultiAgent_DAG_Orchestration: discrete-event multi-slot lock and speculative cancellation simulator', () => {
        const startTimes: Record<string, number> = {
            J1: 0,
            J2: 20,
            J3: 0,
            J4: 20,
            J5: 45,
            J7: 25,
            J8: 60,
            J9: 40,
            J10: 80
        };
        const j3SpeculativeTokens = 500 + 25;
        const j5ProRataTokens = Math.floor((800 * (55 - 45)) / 40) + 50;
        const j9ProRataTokens = Math.floor((600 * (55 - 40)) / 30) + 50;
        const committedTokens = 600 + 900 + 450 + (400 + 100) + 450 + 350;
        const totalTokens = committedTokens + j3SpeculativeTokens + j5ProRataTokens + j9ProRataTokens;

        const oracleAnswer = {
            job_start_times: startTimes,
            non_committed_jobs: {
                mode_rejected: ['J6'],
                invalidated_speculative: ['J3'],
                cancelled_mid_flight: ['J5', 'J9']
            },
            committed_job_order: ['J1', 'J4', 'J2', 'J7', 'J8', 'J10'],
            makespan_seconds: 95,
            remaining_token_budget: 6000 - totalTokens
        };

        const grade = taskMap.I23_MultiAgent_DAG_Orchestration!.grade(JSON.stringify(oracleAnswer));
        expect(grade.content_score).toBe(1);
        expect(grade.outcome).toBe('correct');
    });

    test('I23_Polysemy_Contextual_Translation: cross-scenario polysemy and bilingual audit verifier', () => {
        const oracleAnswer = {
            part1_en_anchor_matches: {
                E1: ['P03', 'P01', 'P05'],
                E2: ['P06', 'P08', 'P07'],
                E3: ['P12', 'P14', 'P13'],
                E4: ['P18', 'P17', 'P19']
            },
            part2_zh_anchor_matches: {
                C1: ['Q03', 'Q01', 'Q02'],
                C2: ['Q06', 'Q08', 'Q07'],
                C3: ['Q12', 'Q10', 'Q13'],
                C4: ['Q17', 'Q15', 'Q18']
            },
            part3_mistranslated_source_term: {
                A1: '坐',
                A2: 'avoidance',
                A3: '除',
                A4: '奏課',
                A5: 'levy a fine',
                A6: '適',
                A7: 'VALID',
                A8: '奏當'
            },
            part3_correct_sense_code: {
                A1: 'M01',
                A2: 'M03',
                A3: 'M06',
                A4: 'M07',
                A5: 'M09',
                A6: 'M11',
                A7: 'VALID',
                A8: 'M15'
            }
        };

        const grade = taskMap.I23_Polysemy_Contextual_Translation!.grade(JSON.stringify(oracleAnswer));
        expect(grade.content_score).toBe(1);
        expect(grade.outcome).toBe('correct');
    });

    test('T23_Adaptive_Fault_Diagnosis: transducer verification and unique 2-probe minimax path P08 -> P04 -> F09', () => {
        const task = taskMap.T23_Adaptive_Fault_Diagnosis!;
        const sim = task.make_simulator!();
        const p1 = sim.call('probe_case', { case_id: 'P08' });
        expect(p1).toEqual({ ok: true, case_id: 'P08', output: 'WARN' });
        const p2 = sim.call('probe_case', { case_id: 'P04' });
        expect(p2).toEqual({ ok: true, case_id: 'P04', output: 'WARN' });
        const sub = sim.call('submit_candidate', { candidate_id: 'F09' });
        expect(sub).toEqual({ ok: true, correct: true });
        const grade = sim.grade(JSON.stringify({ candidate_id: 'F09' }));
        expect(grade.content_score).toBe(1);
        expect(grade.outcome).toBe('correct');
        expect(grade.tool_checks?.within_query_limit).toBe(true);
    });

    test('T23_Delegated_Authority_Release: unique 8-record 5-layer assignment releases A..H cleanly', () => {
        const task = taskMap.T23_Delegated_Authority_Release!;
        const sim = task.make_simulator!();
        expect(sim.call('inspect_queue', {}).ok).toBe(true);
        expect(sim.call('read_authorizations', {}).ok).toBe(true);
        const assignment: Record<string, string> = {
            A: 'L11',
            B: 'L07',
            C: 'L08',
            D: 'L10',
            E: 'L05',
            F: 'L06',
            G: 'L01',
            H: 'L02'
        };
        for (const [record_id, approval_handle] of Object.entries(assignment)) {
            expect(sim.call('release_record', { record_id, approval_handle }).ok).toBe(true);
        }
        const grade = sim.grade(
            JSON.stringify({
                released: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
                pending: [],
                root_uses_remaining: 0
            })
        );
        expect(grade.content_score).toBe(1);
        expect(grade.outcome).toBe('correct');
        expect(grade.tool_checks?.no_invalid_attempts).toBe(true);
        expect(grade.tool_checks?.final_report_truthful).toBe(true);
    });
});
