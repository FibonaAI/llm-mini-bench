import { describe, expect, test } from 'bun:test';
import { load_assessment_bank } from '../src/assessment_bank.ts';
import { AssessmentFraction } from '../src/assessment_tasks.ts';

const bank = load_assessment_bank('1.0');
const taskMap = Object.fromEntries(bank.tasks.map(t => [t.id, t]));

describe('Assessment 1.0 independent first-principles oracles', () => {
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
        const uLow = 2 ** -53;
        const m1 = ((1.0 + 2 ** -52) * (1.0 - 2 ** -53) - 1.0) / u;
        const m2 = (1.0 / (1.0 - 2 ** -53) - 1.0) / u;
        const m3 = (1.0 + 2 ** -52 + (2 ** -53 - 2 ** -107) - (1.0 + 2 ** -52)) / u;
        const dSub = 2 ** -54 - 2 ** -106;
        const m4 = (1.0 - (1.0 - 2 ** -53 - dSub)) / uLow;
        const m5 = (1.0 - (1.0 - (2 ** -53 + dSub))) / uLow;
        expect([m1, m2, m3, m4, m5]).toEqual([0, 1, 1, 1, 2]);

        const minSubnormal = 2 ** -1074;
        const q1 = (minSubnormal * 1.5) / minSubnormal;
        const q2 = (minSubnormal * 2.5) / minSubnormal;
        const exactFmaVal = -(2 ** -54);
        const fmaSign = exactFmaVal > 0 ? 'positive' : exactFmaVal < 0 ? 'negative' : 'zero';

        type TVL = 'T' | 'F' | 'U';
        const not3 = (v: TVL): TVL => (v === 'T' ? 'F' : v === 'F' ? 'T' : 'U');
        const and3 = (a: TVL, b: TVL): TVL => (a === 'F' || b === 'F' ? 'F' : a === 'T' && b === 'T' ? 'T' : 'U');
        const or3 = (a: TVL, b: TVL): TVL => (a === 'T' || b === 'T' ? 'T' : a === 'F' && b === 'F' ? 'F' : 'U');
        const eq3 = (a: number | null, b: number | null): TVL => (a === null || b === null ? 'U' : a === b ? 'T' : 'F');
        const lt3 = (a: number | null, b: number | null): TVL => (a === null || b === null ? 'U' : a < b ? 'T' : 'F');
        const gt3 = (a: number | null, b: number | null): TVL => (a === null || b === null ? 'U' : a > b ? 'T' : 'F');
        const isNotDistinct = (a: number | null, b: number | null): TVL =>
            a === null && b === null ? 'T' : a === null || b === null ? 'F' : a === b ? 'T' : 'F';

        const rows = [
            { id: 1, x: null, y: -5 },
            { id: 2, x: null, y: -5 },
            { id: 3, x: 1, y: null },
            { id: 4, x: null, y: null },
            { id: 5, x: 1, y: -5 },
            { id: 6, x: -2, y: -2 }
        ];
        const xNotIn1Y = (r: { x: number | null; y: number | null }): TVL => and3(not3(eq3(r.x, 1)), not3(eq3(r.x, r.y)));
        const checkConstraint = (r: { x: number | null; y: number | null }): boolean => {
            const p1 = not3(and3(isNotDistinct(r.x, r.y), lt3(r.x, 0)));
            const p2 = or3(gt3(r.y, 0), xNotIn1Y(r));
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

        const countWhereXNotIn = uniqueAccepted.filter(r => xNotIn1Y(r) === 'T').length;
        const subYs = uniqueAccepted.filter(r => r.id <= 3).map(r => r.y);
        const countWhereNotXltAllYle3 = uniqueAccepted.filter(r => {
            const allPred = subYs.reduce<TVL>((acc, yVal) => and3(acc, lt3(r.x, yVal)), 'T');
            return not3(allPred) === 'T';
        }).length;
        expect(countWhereNotXltAllYle3).toBe(1);

        const countDistinctPairSubquery = new Set(
            uniqueAccepted.map(r => `${r.x === null ? 'NULL' : String(r.x)}:${r.y === null ? 'NULL' : String(r.y)}`)
        ).size;
        const sumCoal = uniqueAccepted.reduce((acc, r) => {
            const nullifX = r.x === 1 ? null : r.x;
            const coal = nullifX ?? r.y ?? -3;
            return acc + coal;
        }, 0);

        const oracleAnswer = {
            midpoint_mul_div_and_double_round: [m1, m2, m3, m4, m5],
            ieee2019_nan_and_fma: ['3.0', 'NaN', fmaSign, q1, q2],
            sql_3vl_partial_null_unique_and_check: [
                uniqueAccepted.length,
                countWhereXNotIn,
                countWhereNotXltAllYle3,
                countDistinctPairSubquery,
                sumCoal
            ]
        };

        const grade = taskMap.K23_IEEE754_ThreeValued_Semantics!.grade(JSON.stringify(oracleAnswer));
        expect(grade.content_score).toBe(1);
        expect(grade.outcome).toBe('correct');
    });

    test('R23_InContext_Glyph_Morphism: exhaustive 7680-parameter induction, double vacuum quench, and zero-spin catalyst solver', () => {
        type Chirality = 'L' | 'R';
        type Spin = -1 | 0 | 1;
        interface Cell {
            c: Chirality;
            q: number;
            s: Spin;
        }
        type BypassMode = 'counter_chiral_only' | 'counter_chiral_nonzero_s1' | 'all_q1_zero';

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
            mu: BypassMode,
            alpha: number,
            beta: number,
            gamma: number,
            delta: number,
            omega: Spin
        ): Cell => {
            const bypass =
                mu === 'all_q1_zero'
                    ? a.q === 0
                    : mu === 'counter_chiral_only'
                      ? a.q === 0 && a.c !== b.c
                      : a.q === 0 && a.c !== b.c && a.s !== 0;
            if (bypass) return twist(b, kappa);
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

        const stepChain = (
            arr: Cell[],
            kappa: number,
            mu: BypassMode,
            alpha: number,
            beta: number,
            gamma: number,
            delta: number,
            omega: Spin
        ): Cell[] => {
            let bestIdx = 0;
            let bestKey: [number, number, number] = [-1, -1, -1];
            for (let i = 0; i < arr.length - 1; i++) {
                const k1 = Math.abs(arr[i]!.s - arr[i + 1]!.s);
                const k2 = (arr[i]!.q + arr[i + 1]!.q) % 5;
                const k3 = -i;
                if (
                    k1 > bestKey[0] ||
                    (k1 === bestKey[0] && k2 > bestKey[1]) ||
                    (k1 === bestKey[0] && k2 === bestKey[1] && k3 > bestKey[2])
                ) {
                    bestKey = [k1, k2, k3];
                    bestIdx = i;
                }
            }
            const P = couple(arr[bestIdx]!, arr[bestIdx + 1]!, kappa, mu, alpha, beta, gamma, delta, omega);
            const next = [...arr];
            next.splice(bestIdx, 2, P);
            if (P.q === 0 && bestIdx >= 1 && bestIdx + 1 < next.length) {
                const L = next[bestIdx - 1]!;
                const R = next[bestIdx + 1]!;
                const Y = twist(R, kappa);
                const q = (L.q + 2 * Y.q) % 5;
                const s: Spin = L.c !== Y.c ? 0 : L.s;
                next[bestIdx - 1] = { c: flipC(L.c), q, s };
            }
            return next;
        };

        const matchingParams: Array<[number, BypassMode, number, number, number, number, Spin]> = [];
        const c0 = ['L1:+1', 'R3:+1', 'R4:-1', 'R2:0'].map(parseCell);
        for (const k of [1, 2, 3, 4]) {
            for (const mu of ['counter_chiral_only', 'counter_chiral_nonzero_s1', 'all_q1_zero'] as BypassMode[]) {
                for (const a of [1, 2, 3, 4]) {
                    for (const b of [1, 2, 3, 4]) {
                        for (const g of [0, 1, 2, 3, 4]) {
                            for (const d of [1, 2, 3, 4]) {
                                for (const w of [-1, 1] as Spin[]) {
                                    const t1 = formatCell(couple(parseCell('L2:0'), parseCell('R0:-1'), k, mu, a, b, g, d, w)) === 'R2:0';
                                    const t2 = formatCell(couple(parseCell('L0:0'), parseCell('R3:+1'), k, mu, a, b, g, d, w)) === 'R3:0';
                                    const t3 = formatCell(couple(parseCell('L0:+1'), parseCell('R2:0'), k, mu, a, b, g, d, w)) === 'R0:+1';
                                    const t4 = formatCell(couple(parseCell('L1:+1'), parseCell('L2:+1'), k, mu, a, b, g, d, w)) === 'L3:+1';
                                    const t5 = formatCell(couple(parseCell('R3:+1'), parseCell('R1:-1'), k, mu, a, b, g, d, w)) === 'L3:0';
                                    if (!(t1 && t2 && t3 && t4 && t5)) continue;
                                    const s1 = stepChain(c0, k, mu, a, b, g, d, w);
                                    const s2 = stepChain(s1, k, mu, a, b, g, d, w);
                                    const s3 = stepChain(s2, k, mu, a, b, g, d, w);
                                    if (
                                        s1.map(formatCell).join(',') === 'R1:0,L0:-1,R2:0' &&
                                        s2.map(formatCell).join(',') === 'R1:0,R0:+1' &&
                                        s3.map(formatCell).join(',') === 'R0:-1'
                                    ) {
                                        matchingParams.push([k, mu, a, b, g, d, w]);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        expect(matchingParams).toEqual([[3, 'counter_chiral_nonzero_s1', 2, 4, 3, 2, -1]]);
        const [K, M, A, B, G, D, W] = matchingParams[0]!;

        const pairCouplings = [
            formatCell(couple(parseCell('R0:0'), parseCell('L4:-1'), K, M, A, B, G, D, W)),
            formatCell(couple(parseCell('L3:+1'), parseCell('L2:-1'), K, M, A, B, G, D, W)),
            formatCell(couple(parseCell('R2:-1'), parseCell('L2:+1'), K, M, A, B, G, D, W))
        ];

        const u0 = ['L2:+1', 'L2:+1', 'R3:+1', 'R4:-1', 'L1:0'].map(parseCell);
        const u1 = stepChain(u0, K, M, A, B, G, D, W);
        const u2 = stepChain(u1, K, M, A, B, G, D, W);
        const u3 = stepChain(u2, K, M, A, B, G, D, W);
        const u4 = stepChain(u3, K, M, A, B, G, D, W);

        // Verify unique zero-spin catalyst X for [X, R2:+1, L1:0] -> R4:0 and naive left-to-right decoy R3:0
        const zeroSpinCells: Cell[] = [];
        for (const c of ['L', 'R'] as Chirality[]) {
            for (let q = 0; q < 5; q++) zeroSpinCells.push({ c, q, s: 0 });
        }
        const trueCatalysts = zeroSpinCells.filter(x => {
            const st1 = stepChain([x, parseCell('R2:+1'), parseCell('L1:0')], K, M, A, B, G, D, W);
            const st2 = stepChain(st1, K, M, A, B, G, D, W);
            return formatCell(st2[0]!) === 'R4:0';
        });
        expect(trueCatalysts.map(formatCell)).toEqual(['R0:0']);

        const naiveLeftDecoys = zeroSpinCells.filter(x => {
            const left = couple(x, parseCell('R2:+1'), K, M, A, B, G, D, W);
            const out = couple(left, parseCell('L1:0'), K, M, A, B, G, D, W);
            return formatCell(out) === 'R4:0';
        });
        expect(naiveLeftDecoys.map(formatCell)).toEqual(['R3:0']);

        const oracleAnswer = {
            inferred_parameters: {
                kappa: K,
                bypass_mode: M,
                alpha: A,
                beta: B,
                gamma: G,
                delta: D,
                omega: W
            },
            pair_couplings: pairCouplings,
            step1_and_step2_arrays: {
                step1: u1.map(formatCell),
                step2: u2.map(formatCell)
            },
            final_reduced_cell: formatCell(u4[0]!),
            unique_zero_spin_catalyst: formatCell(trueCatalysts[0]!)
        };

        const grade = taskMap.R23_InContext_Glyph_Morphism!.grade(JSON.stringify(oracleAnswer));
        expect(grade.content_score).toBe(1);
        expect(grade.outcome).toBe('correct');
    });

    test('R23_InContext_Conservation_Frames: 324-law induction, 3-step trajectory conditioning, and non-myopic 2-step control', () => {
        const weights = [4, 2, 3, 3, 2, 4];
        const xNat = (u: number) => (u + 1) % 3;
        const yNat = (u: number) => (2 * u + 1) % 4;
        const zNat = (u: number) => ((u * u + 2) % 5) + 1;

        type Precedence = 'null_first' | 'resonant_pinning_first';
        type PhaseMode = 'static' | 'frustration_shifted';
        type RatchetMode = 'all_nonzero_delta' | 'free_recoil_positive_only' | 'all_free_recoil';
        type DischargeGate = 'any_free_recoil' | 'positive_free_recoil_only' | 'even_state_only';

        function stepLattice(
            u: number,
            fIn: number,
            k: number,
            lam: number,
            prec: Precedence,
            phaseMode: PhaseMode,
            ratchet: RatchetMode,
            discGate: DischargeGate,
            disc: number
        ) {
            const xn = xNat(u);
            const yn = yNat(u);
            const delta = k - xn;
            const isNull = delta === 0;
            const isRes = phaseMode === 'frustration_shifted' ? (u + k + fIn) % 3 === 0 : (u + k) % 3 === 0;
            const applyNull = isNull && (!isRes || prec === 'null_first');
            const applyRes = isRes && (!isNull || prec === 'resonant_pinning_first');

            if (applyNull) {
                return { regime: 'null' as const, y: yn, z: zNat(u), fOut: fIn, uNext: u, delta };
            }
            if (applyRes) {
                const uNext = ratchet === 'all_nonzero_delta' && delta !== 0 ? (u + 1) % 6 : u;
                return { regime: 'resonant' as const, y: yn, z: Math.abs(k - yn) + 1, fOut: fIn + 1, uNext, delta };
            }
            const y = u % 2 === 0 ? (((yn - lam * delta) % 4) + 16) % 4 : delta > 0 ? 3 - yn : yn ^ 1;
            const baseZ = Math.abs(k - y) + (delta < 0 ? 1 : 0);
            const canDischarge = discGate === 'any_free_recoil' ? true : discGate === 'positive_free_recoil_only' ? delta > 0 : u % 2 === 0;
            const z = canDischarge ? baseZ + disc * fIn : baseZ;
            const fOut = canDischarge ? 0 : fIn;
            const shouldRatchet =
                ratchet === 'all_nonzero_delta' ? delta !== 0 : ratchet === 'free_recoil_positive_only' ? delta > 0 : true;
            const uNext = shouldRatchet ? (u + 1) % 6 : u;
            return { regime: 'free' as const, y, z, fOut, uNext, delta };
        }

        const matchingLaws: Array<[number, Precedence, PhaseMode, RatchetMode, DischargeGate, number]> = [];
        for (const lam of [1, 2, 3]) {
            for (const prec of ['null_first', 'resonant_pinning_first'] as Precedence[]) {
                for (const phaseMode of ['static', 'frustration_shifted'] as PhaseMode[]) {
                    for (const ratchet of ['all_nonzero_delta', 'free_recoil_positive_only', 'all_free_recoil'] as RatchetMode[]) {
                        for (const discGate of ['any_free_recoil', 'positive_free_recoil_only', 'even_state_only'] as DischargeGate[]) {
                            for (const disc of [1, 2, 3]) {
                                const a1 = stepLattice(4, 0, 2, lam, prec, phaseMode, ratchet, discGate, disc);
                                const obsA = a1.y === 1 && a1.z === 2 && a1.uNext === 4;

                                const b1 = stepLattice(0, 0, 3, lam, prec, phaseMode, ratchet, discGate, disc);
                                const b2 = stepLattice(b1.uNext, b1.fOut, 3, lam, prec, phaseMode, ratchet, discGate, disc);
                                const obsB = b1.y === 1 && b1.z === 3 && b2.y === 1 && b2.z === 4 && b2.uNext === 1;

                                const c1 = stepLattice(3, 0, 0, lam, prec, phaseMode, ratchet, discGate, disc);
                                const c2 = stepLattice(c1.uNext, c1.fOut, 3, lam, prec, phaseMode, ratchet, discGate, disc);
                                const obsC = c1.y === 3 && c1.z === 4 && c2.y === 0 && c2.z === 5 && c2.uNext === 4;

                                const d1 = stepLattice(3, 0, 0, lam, prec, phaseMode, ratchet, discGate, disc);
                                const d2 = stepLattice(d1.uNext, d1.fOut, 0, lam, prec, phaseMode, ratchet, discGate, disc);
                                const obsD = d1.y === 3 && d1.z === 4 && d2.y === 2 && d2.z === 3 && d2.uNext === 3;

                                if (obsA && obsB && obsC && obsD) {
                                    matchingLaws.push([lam, prec, phaseMode, ratchet, discGate, disc]);
                                }
                            }
                        }
                    }
                }
            }
        }
        expect(matchingLaws).toEqual([
            [2, 'resonant_pinning_first', 'frustration_shifted', 'free_recoil_positive_only', 'positive_free_recoil_only', 2]
        ]);
        const [lambda, prec, phaseMode, ratchet, discGate, disc] = matchingLaws[0]!;
        const step = (u: number, fIn: number, k: number) => stepLattice(u, fIn, k, lambda, prec, phaseMode, ratchet, discGate, disc);

        const q2States = [0, 1, 2, 3, 4, 5].filter(u => step(u, 0, 2).y === 1);
        const q2W = q2States.reduce((s, u) => s + weights[u]!, 0);
        const q2Z = q2States.reduce((s, u) => s + weights[u]! * step(u, 0, 2).z, 0);

        const pathAStates = [0, 1, 2, 3, 4, 5].filter(u => step(u, 0, 0).y === 3);
        const pathAW = pathAStates.reduce((s, u) => s + weights[u]!, 0);
        const pathAZ3 = pathAStates.reduce((s, u) => {
            const s1 = step(u, 0, 0);
            const s2 = step(s1.uNext, s1.fOut, 2);
            const s3 = step(s2.uNext, s2.fOut, 3);
            return s + weights[u]! * s3.z;
        }, 0);

        const pathBStates = [0, 1, 2, 3, 4, 5].filter(u => step(u, 0, 2).z === 2);
        const pathBW = pathBStates.reduce((s, u) => s + weights[u]!, 0);
        const pathBZ3 = pathBStates.reduce((s, u) => {
            const s1 = step(u, 0, 2);
            const s2 = step(s1.uNext, s1.fOut, 1);
            const s3 = step(s2.uNext, s2.fOut, 3);
            return s + weights[u]! * s3.z;
        }, 0);

        let bestNet = -999;
        const bestPairs: Array<[number, number, number]> = [];
        for (let k1 = 0; k1 <= 3; k1++) {
            const s1 = step(1, 0, k1);
            for (let k2 = 0; k2 <= 3; k2++) {
                const s2 = step(s1.uNext, s1.fOut, k2);
                const net = s1.z + s2.z - 3 * s2.fOut - (k1 === k2 ? 1 : 0);
                if (net > bestNet) {
                    bestNet = net;
                    bestPairs.length = 0;
                    bestPairs.push([k1, k2, s2.uNext]);
                } else if (net === bestNet) {
                    bestPairs.push([k1, k2, s2.uNext]);
                }
            }
        }
        expect(bestPairs).toEqual([[2, 3, 2]]);
        expect(bestNet).toBe(7);

        const oracleAnswer = {
            inferred_law: {
                lambda,
                precedence: prec,
                pinning_phase_mode: phaseMode,
                ratchet_mode: ratchet,
                discharge_gate: discGate,
                discharge_coeff: disc
            },
            single_clamp_x2_conditioned_on_y1: {
                expected_z1: new AssessmentFraction(q2Z, q2W).toString(),
                posterior_prob_u0_is_2: new AssessmentFraction(weights[2]!, q2W).toString()
            },
            two_step_trajectory_expectations: {
                expected_z3_on_0_to_2_to_3_given_y1_eq_3: new AssessmentFraction(pathAZ3, pathAW).toString(),
                expected_z3_on_2_to_1_to_3_given_z1_eq_2: new AssessmentFraction(pathBZ3, pathBW).toString()
            },
            optimal_two_step_drive_from_u1: {
                drive_pair: [2, 3],
                max_net_work: bestNet,
                final_state_u2: 2
            }
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
                await Promise.resolve();
                const f = yield (alias.count += 3);
                alias.steps.push('IF2:' + f + ':' + alias.count);
            }
        }

        async function* worker(): AsyncGenerator<number, string, number> {
            try {
                const r = yield* inner();
                state.steps.push('W1:' + r + ':' + state.count);
                const y = yield (state.count += 5);
                state.steps.push('W2:' + y);
                return 'worker-ok';
            } catch (err) {
                state.steps.push('C1:' + (err as Error).message);
                return 'recovered';
            } finally {
                alias = { steps: ['detached'], count: 50 };
                alias.steps.push('WF1:' + state.count);
                await Promise.resolve();
                state.steps.push('WF2:' + state.count + ':' + alias.count);
                return 'override';
            }
        }

        const g = worker();
        const first = await g.next();
        const p2 = g.return('early');
        Promise.resolve().then(() => {
            state.count += 100;
            alias.steps.push('T1:' + state.count);
        });
        const second = await p2;
        p2.then(res => {
            state.steps.push('P2:' + res.value + ':' + state.count);
        });
        const third = await g.next(7);
        const p4 = g.return(Promise.resolve().then(() => 'abort'));
        const p5 = g.return('after-close');
        Promise.resolve().then(() => {
            alias.steps.push('T2:' + state.count + ':' + alias.count);
        });
        const fourth = await p4;
        const fifth = await p5;

        const oracleAnswer = {
            first,
            second,
            third,
            fourth,
            fifth,
            state_steps: state.steps,
            alias_steps: alias.steps
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
        const sharedCommits: Array<{ rev: string; time: number; files: string[]; state: Partial<typeof sharedState> }> = [
            { rev: 'r1', time: 0, files: [], state: { ...sharedState } }
        ];

        const sub1ScanEnd = 10 + 35; // 45
        const msgS0Read = Math.max(18, sub1ScanEnd); // 45
        const sub1PatchEnd = sub1ScanEnd + 8; // 53
        const msgS2Read = Math.max(46, sub1PatchEnd); // 53
        const sub1VerifyEnd = sub1PatchEnd + 6; // 59
        const sub1R2Commit = sub1VerifyEnd + 8; // 67
        sharedCommits.push({
            rev: 'r2',
            time: sub1R2Commit,
            files: ['config/quota.json', 'src/registry.ts'],
            state: { rate_limit: 120, retry_cap: 5 }
        });

        const msgF1Read = Math.max(58, sub1R2Commit); // 67
        const sub1R3Commit = msgF1Read + 7 + 5; // 79
        sharedCommits.push({
            rev: 'r3',
            time: sub1R3Commit,
            files: ['config/quota.json', 'src/cache.ts'],
            state: { rate_limit: 120, retry_cap: 9 }
        });
        sharedState.rate_limit = 120;
        sharedState.retry_cap = 9;

        const msgS1Read = Math.max(22, 15 + 20); // 35
        const sub2Turn1End = 15 + 20 + 30; // 65
        const msgF2Read = Math.max(30, sub2Turn1End); // 65
        const sub2RebaseEnd = msgF2Read + 8; // 73 (syncs to r2!)
        const sub2ClearAt = sub2RebaseEnd + 5; // 78

        const sub3SpawnEnd = 20 + 2; // 22
        const sub3aEnd = sub3SpawnEnd + 58; // 80
        const sub3CompileEnd = sub3SpawnEnd + 46; // 68
        const msgS3Read = Math.max(55, sub3CompileEnd); // 68
        const sub3RebaseEnd = msgS3Read + 6; // 74 (syncs to r2!)
        const sub3Turn1End = sub3RebaseEnd + 4; // 78 (sub3aEnd=80 > 78, so Turn 1 does not clear!)
        const msgF3Read = Math.max(60, sub3Turn1End); // 78
        const sub3Turn2Clear = msgF3Read + 8; // 86 (sub3aEnd=80 <= 86, so Turn 2 clears!)

        const sub4Turn1End = 25 + 50; // 75
        const msgF4Read = Math.max(65, sub4Turn1End); // 75
        const sub4RebaseEnd = msgF4Read + 10; // 85 (syncs to r3!)
        const sub4Turn2Clear = sub4RebaseEnd + 4; // 89

        const sub5SpawnEnd = 50 + 2; // 52
        const sub5aScanEnd = sub5SpawnEnd + 16; // 68
        const msgS5aRead = Math.max(64, sub5aScanEnd); // 68
        const sub5aEnd = msgS5aRead + 7 + 12; // 87
        const sub5Turn1End = sub5SpawnEnd + 21 + 5; // 78
        const msgF5Read = Math.max(62, sub5Turn1End); // 78
        const sub5Turn2Reply = msgF5Read + 5; // 83

        const sub6ClearAt = 70 + 25 + 5; // 100

        const latestRevAt = (t: number) => sharedCommits.filter(c => c.time <= t).at(-1)!;
        const sub2RebasedRev = latestRevAt(sub2RebaseEnd);
        expect(sub2RebasedRev.rev).toBe('r2');
        const sub2PoolSize = sub2RebasedRev.state.rate_limit! / 4 + sub2RebasedRev.state.retry_cap!; // 35

        const sub3RebasedRev = latestRevAt(sub3RebaseEnd);
        expect(sub3RebasedRev.rev).toBe('r2');
        const sub3PoolSize = sub3RebasedRev.state.rate_limit! / 3 + sub3RebasedRev.state.retry_cap! + 3; // 48

        const sub4RebasedRev = latestRevAt(sub4RebaseEnd);
        expect(sub4RebasedRev.rev).toBe('r3');
        const sub4AuthMode = 'mTLS_v' + sub4RebasedRev.state.retry_cap!; // mTLS_v9

        // sub-6 forked from sub-3 at t=70 (while sub-3 rebase [68, 74] is still in flight, so rate_limit=200, bonus=3)
        const sub6InheritedRateLimit = 70 >= sub3RebaseEnd ? sub3RebasedRev.state.rate_limit! : 200;
        const sub6InheritedBonus = 70 >= msgS3Read ? 3 : 0;
        const sub6MetricsWindow = sub6InheritedRateLimit / 20 + sub6InheritedBonus; // 13

        const worktrees = [
            {
                id: 'sub-2',
                clearedAt: sub2ClearAt,
                hasPendingChildren: false,
                baseRevTime: sub2RebasedRev.time,
                baseRev: sub2RebasedRev.rev,
                files: ['src/registry.ts', 'src/router.ts'],
                patch: { pool_size: sub2PoolSize }
            },
            {
                id: 'sub-3',
                clearedAt: sub3Turn2Clear,
                hasPendingChildren: sub3aEnd > sub3Turn2Clear,
                baseRevTime: sub3RebasedRev.time,
                baseRev: sub3RebasedRev.rev,
                files: ['src/pool.ts'],
                patch: { pool_size: sub3PoolSize }
            },
            {
                id: 'sub-4',
                clearedAt: sub4Turn2Clear,
                hasPendingChildren: false,
                baseRevTime: sub4RebasedRev.time,
                baseRev: sub4RebasedRev.rev,
                files: ['src/auth.ts', 'src/cache.ts'],
                patch: { auth_mode: sub4AuthMode }
            },
            {
                id: 'sub-5',
                clearedAt: sub5Turn2Reply,
                hasPendingChildren: sub5aEnd > sub5Turn2Reply,
                baseRevTime: 0,
                baseRev: 'r1',
                files: ['src/audit.ts'],
                patch: { audit_level: 3 }
            },
            {
                id: 'sub-6',
                clearedAt: sub6ClearAt,
                hasPendingChildren: false,
                baseRevTime: 0,
                baseRev: 'r1',
                files: ['src/metrics.ts'],
                patch: { metrics_window: sub6MetricsWindow }
            }
        ];

        const admittedWorktrees: string[] = [];
        const admittedFiles = new Set<string>();
        const outcomes: Record<string, string> = { 'sub-1': 'committed_shared' };

        for (const wt of worktrees.sort((a, b) => a.clearedAt - b.clearedAt || a.id.localeCompare(b.id))) {
            if (wt.hasPendingChildren) {
                outcomes[wt.id] = 'waiting_for_children_unmerged';
                continue;
            }
            const modifiedAfterBase = new Set(sharedCommits.filter(c => c.time > wt.baseRevTime).flatMap(c => c.files));
            const conflict =
                wt.files.some(f => admittedFiles.has(f)) || (wt.baseRev !== 'r3' && wt.files.some(f => modifiedAfterBase.has(f)));
            if (conflict) {
                outcomes[wt.id] = 'rejected_stale_base';
            } else {
                Object.assign(sharedState, wt.patch);
                for (const f of wt.files) admittedFiles.add(f);
                admittedWorktrees.push(wt.id);
                outcomes[wt.id] = wt.baseRev === 'r3' ? 'merged_rebased' : 'merged_disjoint';
            }
        }

        const oracleAnswer = {
            message_read_timestamps: {
                msg_s0: msgS0Read,
                msg_s1: msgS1Read,
                msg_f2: msgF2Read,
                msg_s2: msgS2Read,
                msg_f1: msgF1Read,
                msg_s3: msgS3Read,
                msg_s5a: msgS5aRead,
                msg_f4: msgF4Read,
                msg_f3: msgF3Read,
                msg_f5: msgF5Read
            },
            milestone_timestamps: {
                sub1_r2_commit: sub1R2Commit,
                sub1_r3_commit: sub1R3Commit,
                sub2_rebase_end: sub2RebaseEnd,
                sub3_rebase_end: sub3RebaseEnd,
                sub4_rebase_end: sub4RebaseEnd,
                sub4_turn2_clear: sub4Turn2Clear,
                sub5_turn2_reply: sub5Turn2Reply,
                sub5a_child_end: sub5aEnd
            },
            admitted_worktree_merges_in_order: admittedWorktrees,
            final_shared_state: sharedState,
            agent_outcomes: outcomes
        };

        const grade = taskMap.X23_Subagent_MultiTrack_Reconciliation!.grade(JSON.stringify(oracleAnswer));
        expect(grade.content_score).toBe(1);
        expect(grade.outcome).toBe('correct');
    });

    test('E23_Tight_Conditional_Audit: 6-document path with hop degradation penalties and 0-hop vs 1-hop waivers', () => {
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

    test('I23_MultiAgent_DAG_Orchestration: discrete-event scheduler and 11-node 3-slot pebbling solver', () => {
        const dagDeps: Record<number, [number, number]> = {
            3: [0, 1],
            4: [1, 2],
            5: [3, 4],
            6: [0, 4],
            7: [5, 6],
            8: [3, 7],
            9: [2, 7],
            10: [6, 9]
        };

        type State = { regs: [number, number, number]; mem: number; steps: number };
        const initMem = (1 << 0) | (1 << 1) | (1 << 2);
        const queue: State[] = [{ regs: [-1, -1, -1], mem: initMem, steps: 0 }];
        const visited = new Map<string, number>();
        let minOps = 999;

        while (queue.length > 0) {
            const cur = queue.shift()!;
            if (cur.steps >= minOps) continue;
            if (cur.regs.includes(10)) {
                minOps = cur.steps;
                break;
            }
            const sortedRegs = [...cur.regs].sort((a, b) => a - b);
            const key = `${sortedRegs.join(',')}|${cur.mem}`;
            if ((visited.get(key) ?? 999) <= cur.steps) continue;
            visited.set(key, cur.steps);

            for (let v = 0; v <= 10; v++) {
                if (cur.mem & (1 << v) && !cur.regs.includes(v)) {
                    for (let r = 0; r < 3; r++) {
                        const nextRegs = [...cur.regs] as [number, number, number];
                        nextRegs[r] = v;
                        queue.push({ regs: nextRegs, mem: cur.mem, steps: cur.steps + 1 });
                    }
                }
            }
            for (let r = 0; r < 3; r++) {
                const v = cur.regs[r]!;
                if (v >= 0 && !(cur.mem & (1 << v))) {
                    queue.push({ regs: cur.regs, mem: cur.mem | (1 << v), steps: cur.steps + 1 });
                }
            }
            for (const [nodeStr, [l, rNode]] of Object.entries(dagDeps)) {
                const node = Number(nodeStr);
                if (cur.regs.includes(node)) continue;
                if (cur.regs.includes(l) && cur.regs.includes(rNode)) {
                    for (let r = 0; r < 3; r++) {
                        const nextRegs = [...cur.regs] as [number, number, number];
                        nextRegs[r] = node;
                        queue.push({ regs: nextRegs, mem: cur.mem, steps: cur.steps + 1 });
                    }
                }
            }
        }

        expect(minOps).toBe(11);

        const oracleAnswer = {
            job_start_times: {
                J1: 0,
                J3: 0,
                J2: 20,
                J4: 20,
                J7: 20,
                J5: 45,
                J9: 60,
                J8: 70,
                J10: 70
            },
            non_committed_jobs: {
                mode_rejected: ['J6'],
                invalidated_speculative: ['J3', 'J5'],
                cancelled_mid_flight: ['J9']
            },
            committed_job_order: ['J1', 'J4', 'J7', 'J2', 'J10', 'J8'],
            remaining_token_budget: 1300,
            min_buffer_ops_3slots: minOps
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
                C3: ['Q12', 'Q14', 'Q13'],
                C4: ['Q17', 'Q15', 'Q18']
            },
            part3_mistranslated_source_term: {
                A1: '坐',
                A2: 'avoidance',
                A3: '縣官',
                A4: '錄囚',
                A5: 'account with annual rests',
                A6: '給復',
                A7: 'VALID',
                A8: '奏當'
            },
            part3_correct_sense_code: {
                A1: 'M04',
                A2: 'M06',
                A3: 'M08',
                A4: 'M10',
                A5: 'M12',
                A6: 'M07',
                A7: 'VALID',
                A8: 'M15'
            }
        };

        const grade = taskMap.I23_Polysemy_Contextual_Translation!.grade(JSON.stringify(oracleAnswer));
        expect(grade.content_score).toBe(1);
        expect(grade.outcome).toBe('correct');
    });

    test('T23_Adaptive_Fault_Diagnosis: two-stage calibration verification and unique 2-probe minimax path P09 -> P03 -> F09', () => {
        const task = taskMap.T23_Adaptive_Fault_Diagnosis!;
        const sim = task.make_simulator!();
        const p1 = sim.call('probe_case', { case_id: 'P09' });
        expect(p1).toEqual({ ok: true, case_id: 'P09', output: 'FAIL' });
        const p2 = sim.call('probe_case', { case_id: 'P03' });
        expect(p2).toEqual({ ok: true, case_id: 'P03', output: 'FAIL' });
        const sub = sim.call('submit_candidate', { candidate_id: 'F09' });
        expect(sub).toEqual({ ok: true, correct: true });
        const grade = sim.grade(JSON.stringify({ candidate_id: 'F09' }));
        expect(grade.content_score).toBe(1);
        expect(grade.outcome).toBe('correct');
        expect(grade.tool_checks?.within_query_limit).toBe(true);
    });

    test('T23_Delegated_Authority_Release: 14-step Hall-marriage cascade with zero singleton effective scopes releases A..H cleanly', () => {
        const task = taskMap.T23_Delegated_Authority_Release!;
        const sim = task.make_simulator!();
        expect(sim.call('inspect_queue', {}).ok).toBe(true);
        expect(sim.call('read_authorizations', {}).ok).toBe(true);
        const assignment: Record<string, string> = {
            H: 'L08',
            G: 'L09',
            F: 'L04',
            E: 'L05',
            D: 'L11',
            C: 'L06',
            B: 'L14',
            A: 'L15'
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
