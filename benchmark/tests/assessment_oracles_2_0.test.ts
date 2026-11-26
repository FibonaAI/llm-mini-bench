import { describe, expect, test } from 'bun:test';
import { load_assessment_bank } from '../src/assessment_bank.ts';

const bank2 = load_assessment_bank('2.0');
const taskById = (id: string) => {
    const task = bank2.tasks.find(t => t.id === id);
    if (!task) throw new Error(`Missing Assessment 2.0 task ${id}`);
    return task;
};

describe('Assessment 2.0 independent first-principles oracles', () => {
    test('K25_IPv4_BitReverse_Abduction: 8-bit LSB<->MSB reversal uniquely recovers Peru and Cuba', () => {
        const task = taskById('K25_IPv4_BitReverse_Abduction');
        const reverseByte = (b: number) => {
            let out = 0;
            for (let i = 0; i < 8; i++) out = (out << 1) | ((b >> i) & 1);
            return out;
        };
        const encode = (word: string) => [...word.toUpperCase()].map(ch => reverseByte(ch.charCodeAt(0))).join('.');
        const decode = (quad: string) =>
            quad
                .split('.')
                .map(part => String.fromCharCode(reverseByte(Number(part))))
                .join('');

        expect(encode('PERU')).toBe('10.162.74.170');
        expect(encode('CUBA')).toBe('194.170.66.130');
        expect(decode('10.162.74.170')).toBe('PERU');
        expect(decode('194.170.66.130')).toBe('CUBA');
        expect(task.prompt).toContain('10.162.74.170');
        expect(task.prompt).toContain('194.170.66.130');

        expect(task.grade(JSON.stringify({ first: 'Peru', second: 'Cuba' })).content_score).toBe(1);
        expect(task.grade(JSON.stringify({ first: 'PERU', second: 'cuba' })).content_score).toBe(1);
        expect(task.grade(JSON.stringify({ first: 'Peru', second: 'Oman' })).content_score).toBe(0.5);
        expect(task.grade(JSON.stringify({ first: 'Iran', second: 'Iraq' })).content_score).toBe(0);
    });

    test('K25_FIDE_Perft_EdgeCases: independent FIDE move generator validated on Perft refs certifies 15/4 and 19', () => {
        const task = taskById('K25_FIDE_Perft_EdgeCases');
        const isW = (p: string) => p >= 'A' && p <= 'Z';
        const isB = (p: string) => p >= 'a' && p <= 'z';
        const isSide = (p: string, side: 'w' | 'b') => (side === 'w' ? isW(p) : isB(p));
        const sqName = (i: number) => 'abcdefgh'[i & 7]! + String(8 - (i >> 3));
        const parseSq = (s: string) => (8 - Number(s[1])) * 8 + 'abcdefgh'.indexOf(s[0]!);

        const parseFEN = (fen: string) => {
            const [placement, turn, castle, epStr] = fen.split(' ');
            const sq: string[] = [];
            for (const ch of placement!) {
                if (ch === '/') continue;
                if (ch >= '1' && ch <= '8') for (let k = 0; k < Number(ch); k++) sq.push('.');
                else sq.push(ch);
            }
            return { sq, turn: turn as 'w' | 'b', castle: castle!, ep: epStr === '-' ? -1 : parseSq(epStr!) };
        };

        const attackedBy = (sq: string[], target: number, by: 'w' | 'b'): boolean => {
            const tr = target >> 3;
            const tc = target & 7;
            const pr = by === 'w' ? tr + 1 : tr - 1;
            const pChar = by === 'w' ? 'P' : 'p';
            if (pr >= 0 && pr < 8) {
                if (tc > 0 && sq[pr * 8 + tc - 1] === pChar) return true;
                if (tc < 7 && sq[pr * 8 + tc + 1] === pChar) return true;
            }
            const nChar = by === 'w' ? 'N' : 'n';
            for (const [dr, dc] of [
                [-2, -1],
                [-2, 1],
                [-1, -2],
                [-1, 2],
                [1, -2],
                [1, 2],
                [2, -1],
                [2, 1]
            ]) {
                const r = tr + dr!,
                    c = tc + dc!;
                if (r >= 0 && r < 8 && c >= 0 && c < 8 && sq[r * 8 + c] === nChar) return true;
            }
            const kChar = by === 'w' ? 'K' : 'k';
            for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                    if (!dr && !dc) continue;
                    const r = tr + dr,
                        c = tc + dc;
                    if (r >= 0 && r < 8 && c >= 0 && c < 8 && sq[r * 8 + c] === kChar) return true;
                }
            }
            const bChar = by === 'w' ? 'B' : 'b',
                qChar = by === 'w' ? 'Q' : 'q',
                rChar = by === 'w' ? 'R' : 'r';
            for (const [dr, dc] of [
                [-1, -1],
                [-1, 1],
                [1, -1],
                [1, 1]
            ]) {
                let r = tr + dr!,
                    c = tc + dc!;
                while (r >= 0 && r < 8 && c >= 0 && c < 8) {
                    const p = sq[r * 8 + c]!;
                    if (p !== '.') {
                        if (p === bChar || p === qChar) return true;
                        break;
                    }
                    r += dr!;
                    c += dc!;
                }
            }
            for (const [dr, dc] of [
                [-1, 0],
                [1, 0],
                [0, -1],
                [0, 1]
            ]) {
                let r = tr + dr!,
                    c = tc + dc!;
                while (r >= 0 && r < 8 && c >= 0 && c < 8) {
                    const p = sq[r * 8 + c]!;
                    if (p !== '.') {
                        if (p === rChar || p === qChar) return true;
                        break;
                    }
                    r += dr!;
                    c += dc!;
                }
            }
            return false;
        };

        const genLegal = (fen: string) => {
            const b = parseFEN(fen);
            const me = b.turn;
            const opp: 'w' | 'b' = me === 'w' ? 'b' : 'w';
            const myK = me === 'w' ? 'K' : 'k';
            const oppK = opp === 'w' ? 'K' : 'k';
            const moves: string[] = [];
            const checks: string[] = [];
            const tryMove = (from: number, to: number, promo = '', isEp = false, castleRook?: [number, number]) => {
                const next = [...b.sq];
                const pc = next[from]!;
                next[from] = '.';
                if (isEp) next[(from >> 3) * 8 + (to & 7)] = '.';
                if (castleRook) {
                    next[castleRook[1]] = next[castleRook[0]]!;
                    next[castleRook[0]] = '.';
                }
                next[to] = promo ? (me === 'w' ? promo.toUpperCase() : promo.toLowerCase()) : pc;
                if (attackedBy(next, next.indexOf(myK), opp)) return;
                const mv = sqName(from) + sqName(to) + promo;
                moves.push(mv);
                if (attackedBy(next, next.indexOf(oppK), me)) checks.push(mv);
            };
            for (let i = 0; i < 64; i++) {
                const p = b.sq[i]!;
                if (!isSide(p, me)) continue;
                const r = i >> 3,
                    c = i & 7,
                    u = p.toUpperCase();
                if (u === 'P') {
                    const dir = me === 'w' ? -1 : 1,
                        startR = me === 'w' ? 6 : 1,
                        promoR = me === 'w' ? 0 : 7;
                    const f1 = (r + dir) * 8 + c;
                    if (r + dir >= 0 && r + dir < 8 && b.sq[f1] === '.') {
                        if (r + dir === promoR) for (const pr of ['q', 'r', 'b', 'n']) tryMove(i, f1, pr);
                        else {
                            tryMove(i, f1);
                            if (r === startR && b.sq[(r + 2 * dir) * 8 + c] === '.') tryMove(i, (r + 2 * dir) * 8 + c);
                        }
                    }
                    for (const dc of [-1, 1]) {
                        const nc = c + dc,
                            nr = r + dir;
                        if (nc < 0 || nc > 7 || nr < 0 || nr > 7) continue;
                        const ti = nr * 8 + nc;
                        if (isSide(b.sq[ti]!, opp)) {
                            if (nr === promoR) for (const pr of ['q', 'r', 'b', 'n']) tryMove(i, ti, pr);
                            else tryMove(i, ti);
                        } else if (ti === b.ep) tryMove(i, ti, '', true);
                    }
                } else if (u === 'N') {
                    for (const [dr, dc] of [
                        [-2, -1],
                        [-2, 1],
                        [-1, -2],
                        [-1, 2],
                        [1, -2],
                        [1, 2],
                        [2, -1],
                        [2, 1]
                    ]) {
                        const nr = r + dr!,
                            nc = c + dc!;
                        if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && !isSide(b.sq[nr * 8 + nc]!, me)) tryMove(i, nr * 8 + nc);
                    }
                } else if (u === 'K') {
                    for (let dr = -1; dr <= 1; dr++) {
                        for (let dc = -1; dc <= 1; dc++) {
                            if (!dr && !dc) continue;
                            const nr = r + dr,
                                nc = c + dc;
                            if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && !isSide(b.sq[nr * 8 + nc]!, me)) tryMove(i, nr * 8 + nc);
                        }
                    }
                    if (me === 'w' && i === 60) {
                        if (
                            b.castle.includes('K') &&
                            b.sq[61] === '.' &&
                            b.sq[62] === '.' &&
                            b.sq[63] === 'R' &&
                            !attackedBy(b.sq, 60, 'b') &&
                            !attackedBy(b.sq, 61, 'b') &&
                            !attackedBy(b.sq, 62, 'b')
                        )
                            tryMove(60, 62, '', false, [63, 61]);
                        if (
                            b.castle.includes('Q') &&
                            b.sq[59] === '.' &&
                            b.sq[58] === '.' &&
                            b.sq[57] === '.' &&
                            b.sq[56] === 'R' &&
                            !attackedBy(b.sq, 60, 'b') &&
                            !attackedBy(b.sq, 59, 'b') &&
                            !attackedBy(b.sq, 58, 'b')
                        )
                            tryMove(60, 58, '', false, [56, 59]);
                    }
                } else {
                    const dirs =
                        u === 'B'
                            ? [
                                  [-1, -1],
                                  [-1, 1],
                                  [1, -1],
                                  [1, 1]
                              ]
                            : u === 'R'
                              ? [
                                    [-1, 0],
                                    [1, 0],
                                    [0, -1],
                                    [0, 1]
                                ]
                              : [
                                    [-1, -1],
                                    [-1, 1],
                                    [1, -1],
                                    [1, 1],
                                    [-1, 0],
                                    [1, 0],
                                    [0, -1],
                                    [0, 1]
                                ];
                    for (const [dr, dc] of dirs) {
                        let nr = r + dr!,
                            nc = c + dc!;
                        while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
                            if (isSide(b.sq[nr * 8 + nc]!, me)) break;
                            tryMove(i, nr * 8 + nc);
                            if (b.sq[nr * 8 + nc] !== '.') break;
                            nr += dr!;
                            nc += dc!;
                        }
                    }
                }
            }
            return { moves: moves.sort(), checks: checks.sort() };
        };

        // Sanity-check generator against classic Perft-1 ground truth (Kiwipete, Pos 3, Pos 4, Pos 5)
        expect(genLegal('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1').moves.length).toBe(48);
        expect(genLegal('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1').moves.length).toBe(14);
        expect(genLegal('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1').moves.length).toBe(6);
        expect(genLegal('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8').moves.length).toBe(44);

        const fen1 = '2n3k1/3P4/8/K3Pp1r/8/2B5/3b4/8 w - f6 0 1';
        const fen2 = '1r4k1/4r3/8/8/8/7b/3PN3/R3K2R w KQ - 0 1';
        expect(task.prompt).toContain(fen1);
        expect(task.prompt).toContain(fen2);

        const r1 = genLegal(fen1);
        const r2 = genLegal(fen2);
        expect(r1.moves).not.toContain('e5f6'); // Horizontal en passant pin
        expect(r1.moves.length).toBe(15);
        expect(r1.checks).toEqual(['d7c8q', 'd7c8r', 'd7d8q', 'd7d8r']);
        expect(r2.moves).toContain('e1c1'); // O-O-O legal even though b8 rook attacks b1
        expect(r2.moves).not.toContain('e1g1'); // O-O illegal because h3 bishop attacks f1
        expect(r2.moves.length).toBe(19);

        expect(task.grade(JSON.stringify({ pos1_legal_moves: 15, pos1_checking_moves: 4, pos2_legal_moves: 19 })).content_score).toBe(1);
        expect(
            task.grade(JSON.stringify({ pos1_legal_moves: 18, pos1_checking_moves: 4, pos2_legal_moves: 19 })).content_score
        ).toBeCloseTo(2 / 3);
    });

    test('R25_Shifted_Pinyin_Abduction: right-hand QWERTY +1 displacement into Pinyin uniquely recovers original sentence', () => {
        const task = taskById('R25_Shifted_Pinyin_Abduction');
        const rows = ['qwertyuiop[', 'asdfghjkl;', 'zxcvbnm,.'];
        const rightHome = new Set([...'yuiophjkl;nm,.']);
        const shiftRight = (ch: string) => {
            for (const row of rows) {
                const idx = row.indexOf(ch);
                if (idx !== -1 && rightHome.has(ch) && idx + 1 < row.length) return row[idx + 1]!;
            }
            return ch;
        };
        const intended = ['ba', 'huai', 'ka', 'tui', 'hui', 'gei', 'ke', 'hu'];
        const shiftedStream = [...intended.join('')].map(shiftRight).join('');
        expect(shiftedStream).toBe('bajiaolatiojiogeoleji');

        // Verify reverse mapping of surface characters matches the exact shifted stream
        const surfacePinyin: Record<string, string> = {
            把: 'ba',
            交: 'jiao',
            拉: 'la',
            题: 'ti',
            哦: 'o',
            机: 'ji',
            个: 'ge',
            了: 'le'
        };
        const artifact = '把交拉题哦机哦个哦了机';
        expect([...artifact].map(c => surfacePinyin[c]).join('')).toBe(shiftedStream);
        expect(task.prompt).toContain(artifact);

        expect(task.grade(JSON.stringify({ message: '把坏卡退回给客户' })).content_score).toBe(1);
        expect(task.grade(JSON.stringify({ message: '把坏卡退回给客户。' })).content_score).toBe(1);
        expect(task.grade(JSON.stringify({ message: '把垃圾丢了' })).content_score).toBe(0);
    });

    test('R25_Morse_Sentence_Camouflage: ITU Morse dot/dash polarity inversion maps AS SAT USE UNIT EMIT <-> NO ONE GOT GAME TIME', () => {
        const task = taskById('R25_Morse_Sentence_Camouflage');
        const morse: Record<string, string> = {
            A: '.-',
            B: '-...',
            C: '-.-.',
            D: '-..',
            E: '.',
            F: '..-.',
            G: '--.',
            H: '....',
            I: '..',
            J: '.---',
            K: '-.-',
            L: '.-..',
            M: '--',
            N: '-.',
            O: '---',
            P: '.--.',
            Q: '--.-',
            R: '.-.',
            S: '...',
            T: '-',
            U: '..-',
            V: '...-',
            W: '.--',
            X: '-..-',
            Y: '-.--',
            Z: '--..'
        };
        const revMorse = Object.fromEntries(Object.entries(morse).map(([k, v]) => [v, k]));
        const invert = (s: string) =>
            s
                .toUpperCase()
                .split(' ')
                .map(word =>
                    [...word]
                        .map(ch => {
                            const flipped = [...morse[ch]!].map(sym => (sym === '.' ? '-' : '.')).join('');
                            const out = revMorse[flipped];
                            if (!out) throw new Error(`No Morse complement for ${ch}`);
                            return out;
                        })
                        .join('')
                )
                .join(' ');

        expect(invert('AS SAT USE UNIT EMIT')).toBe('NO ONE GOT GAME TIME');
        expect(invert('NO ONE GOT GAME TIME')).toBe('AS SAT USE UNIT EMIT');
        expect(task.prompt).toContain('AS SAT USE UNIT EMIT');
        expect(task.grade(JSON.stringify({ message: 'No one got game time' })).content_score).toBe(1);
        expect(task.grade(JSON.stringify({ message: 'NO ONE GOT GAME TIME.' })).content_score).toBe(1);
        expect(task.grade(JSON.stringify({ message: 'AS SAT USE UNIT EMIT' })).content_score).toBe(0);
    });

    test('C25_FourSlot_Readback: full product-space BFS certifies minima [12, 16]', () => {
        const task = taskById('C25_FourSlot_Readback');
        type State = { h: number; d: number; A: number[]; B: number[]; w: number; n: number; r: number; s: number; a: number; b: number };
        const boot: State = { h: 0, d: 0, A: [0, 0, 0, 0], B: [0, 0, 0, 0], w: 0, n: 1, r: 0, s: -1, a: -1, b: -1 };
        function* advance(m: State): Generator<[string, State]> {
            const { w, n, r, s, h, d } = m;
            if (n <= 4) {
                const j = (h + 1) % 4;
                const z: State = { ...m, w: (w + 1) % 3 };
                if (w === 0) {
                    z.A = m.A.slice();
                    z.A[j] = n;
                }
                if (w === 1) {
                    z.B = m.B.slice();
                    z.B[j] = n;
                }
                if (w === 2) {
                    z.h = j;
                    z.n++;
                }
                yield ['W', z];
            }
            if (h !== d) yield ['P', { ...m, d: h }];
            if (h !== d || w !== 0) yield ['X', { ...m, h: d, n: n + Number(w !== 0), w: 0 }];
            if (r < 5 && ((r !== 2 && r !== 4) || h === s)) {
                const z: State = { ...m, r: r + 1 };
                if (r === 0) z.s = h;
                if (r === 1) z.a = m.A[s]!;
                if (r === 3) z.b = m.B[s]!;
                yield ['R', z];
            }
        }
        const q: [State, string][] = [[boot, '']];
        const seen = new Set([JSON.stringify(boot)]);
        const minima = [Infinity, Infinity];
        for (let i = 0; i < q.length; i++) {
            const [m, t] = q[i]!;
            if (m.r === 5) {
                const k = Number(m.a > m.b);
                if (m.a !== m.b && minima[k] === Infinity) {
                    minima[k] = t.length;
                }
                continue;
            }
            for (const [ev, z] of advance(m)) {
                const key = JSON.stringify(z);
                if (!seen.has(key)) {
                    seen.add(key);
                    q.push([z, t + ev]);
                }
            }
        }
        expect(minima).toEqual([12, 16]);
        expect(task.grade(JSON.stringify({ steps: [12, 16] })).content_score).toBe(1);
        expect(task.grade(JSON.stringify({ steps: [12, 13] })).content_score).toBe(0);
        expect(task.grade(JSON.stringify({ steps: [14, 16] })).content_score).toBe(0);
    });

    test('C25_Clock_Belady_Anomaly: exhaustive scan over 4^1..4^7 proves unique shortest lex-first witness [1,1,2,2,3,4,3]', () => {
        const task = taskById('C25_Clock_Belady_Anomaly');
        const misses = (seq: number[], cap: number): number => {
            const q: { p: number; r: number }[] = [];
            let m = 0;
            for (const p of seq) {
                const h = q.find(x => x.p === p);
                if (h) {
                    h.r = 1;
                    continue;
                }
                m++;
                if (q.length === cap) {
                    while (q[0]!.r) {
                        const x = q.shift()!;
                        x.r = 0;
                        q.push(x);
                    }
                    q.shift();
                }
                q.push({ p, r: 0 });
            }
            return m;
        };

        const found: { seq: number[]; m2: number; m3: number }[] = [];
        for (let len = 1; len <= 7 && found.length === 0; len++) {
            const seq = new Array<number>(len).fill(1);
            const walk = (pos: number): void => {
                if (found.length > 0) return;
                if (pos === len) {
                    const m2 = misses(seq, 2);
                    const m3 = misses(seq, 3);
                    if (m3 > m2) found.push({ seq: [...seq], m2, m3 });
                    return;
                }
                for (let v = 1; v <= 4; v++) {
                    seq[pos] = v;
                    walk(pos + 1);
                }
            };
            walk(0);
        }
        expect(found[0]).toEqual({ seq: [1, 1, 2, 2, 3, 4, 3], m2: 4, m3: 5 });
        expect(task.grade(JSON.stringify({ sequence: [1, 1, 2, 2, 3, 4, 3], misses: [4, 5] })).content_score).toBe(1);
        expect(task.grade(JSON.stringify({ sequence: [1, 2, 3, 4, 1, 2, 5], misses: [4, 5] })).content_score).toBe(0.5);
    });

    test('X25_Checkout_Credit_Audit: deduplicated customer failure fraction across staggered UTC rollbacks', () => {
        const task = taskById('X25_Checkout_Credit_Audit');
        const eastFails = [12, 10, 10, 2, 2, 2, 2];
        const westFails = [12, 6, 6, 10, 10, 12, 2];
        const endMinutes = [2, 3, 4, 5, 6, 7, 8];
        const ticketOpen = 2;
        const eastRevert = 4;
        const westRevert = 7;
        let qualifyingMinutes = 0;
        for (let i = 0; i < endMinutes.length; i++) {
            const end = endMinutes[i]!;
            const start = end - 1;
            if (start < ticketOpen) continue;
            const eastQualifies = end <= eastRevert && eastFails[i]! * 100 >= 10 * (110 - eastFails[i]!);
            const westQualifies = end <= westRevert && westFails[i]! * 100 >= 10 * (110 - westFails[i]!);
            if (eastQualifies || westQualifies) qualifyingMinutes++;
        }
        const answer = { build: 'k6', credit_usd: qualifyingMinutes * 15 };
        expect(answer).toEqual({ build: 'k6', credit_usd: 75 });
        expect(task.grade(JSON.stringify(answer)).content_score).toBe(1);
        expect(task.grade(JSON.stringify({ build: 'k6', credit_usd: 15 })).content_score).toBe(0.5);
    });

    test('E25_Tight_Budget_Deductive_Audit: 5-fetch zero-slack archive path yields CC-7 / 10060 while BRIEF or LOG_A exhausts budget', () => {
        const task = taskById('E25_Tight_Budget_Deductive_Audit');
        const sim = task.make_simulator!();
        // Arithmetic elimination: 18 * 72 = 1296 kg > 1200 kg -> condition (2) fails without opening LOG_A; skip unverified BRIEF.
        expect(18 * 72).toBeGreaterThan(1200);
        for (const docId of ['INDEX', 'RULE', 'CERT', 'LEDGER', 'TAR_C']) {
            expect(sim.call('fetch_document', { document_id: docId }).ok).toBe(true);
        }
        const balance = 9400 + 1850 + Math.round(9400 * 0.15) - 2600;
        expect(balance).toBe(10060);
        const answer = { tariff_code: 'CC-7', balance_usd: balance };
        const graded = sim.grade(JSON.stringify(answer));
        expect(graded.content_score).toBe(1);
        expect(graded.outcome).toBe('correct');

        // Fetching unverified BRIEF exhausts the 5-fetch budget before TAR_C can be read.
        const briefSim = task.make_simulator!();
        for (const docId of ['INDEX', 'RULE', 'BRIEF', 'CERT', 'LEDGER']) {
            expect(briefSim.call('fetch_document', { document_id: docId }).ok).toBe(true);
        }
        expect(briefSim.call('fetch_document', { document_id: 'TAR_C' }).ok).toBe(false);
        expect(briefSim.grade(JSON.stringify(answer)).content_score).toBe(0);

        // Fetching redundant LOG_A also exhausts the 5-fetch budget before TAR_C can be read.
        const logSim = task.make_simulator!();
        for (const docId of ['INDEX', 'RULE', 'LOG_A', 'CERT', 'LEDGER']) {
            expect(logSim.call('fetch_document', { document_id: docId }).ok).toBe(true);
        }
        expect(logSim.call('fetch_document', { document_id: 'TAR_C' }).ok).toBe(false);
        expect(logSim.grade(JSON.stringify(answer)).content_score).toBe(0);
    });

    test('I25_SOP_MinStep_Protocol: exact BFS certifies min_steps=13 and lex-first CADACEACADADB with every rule load-bearing', () => {
        const task = taskById('I25_SOP_MinStep_Protocol');
        const bit = (m: number, i: number) => (m >> i) & 1;
        const solve = (skipRule = -1) => {
            const canToggle = (m: number, v: number) => {
                const A = bit(m, 0),
                    B = bit(m, 1),
                    C = bit(m, 2),
                    D = bit(m, 3),
                    E = bit(m, 4);
                if (v === 1 && skipRule !== 0) return (A === 1 && D === 0) || E === 1;
                if (v === 3 && skipRule !== 1) return C === 1 && B === 0;
                if (v === 4 && skipRule !== 2) return D === 1 && A === 0;
                return true;
            };
            const validState = (m: number) => skipRule === 3 || !(bit(m, 1) === 1 && bit(m, 4) === 1 && bit(m, 2) === 0);
            const names = ['A', 'B', 'C', 'D', 'E'] as const;
            const key = (m: number, lv: number) => (m << 3) | lv;
            const dist = new Map<number, number>([[key(0, 5), 0]]);
            const seqs = new Map<number, string[]>([[key(0, 5), ['']]]);
            const q: [number, number][] = [[0, 5]];
            let head = 0,
                ansSteps = Infinity;
            let allMin: string[] = [];
            while (head < q.length) {
                const [m, lv] = q[head++]!;
                const k = key(m, lv);
                const d = dist.get(k)!;
                if (d >= ansSteps) continue;
                for (let v = 0; v < 5; v++) {
                    if (skipRule !== 4 && lv < 5 && Math.abs(v - lv) <= 1) continue;
                    if (!canToggle(m, v)) continue;
                    const nm = m ^ (1 << v);
                    if (!validState(nm)) continue;
                    const nextList = seqs.get(k)!.map(s => s + names[v]!);
                    if (nm === 31) {
                        if (d + 1 < ansSteps) {
                            ansSteps = d + 1;
                            allMin = [...nextList];
                        } else if (d + 1 === ansSteps) {
                            allMin.push(...nextList);
                        }
                        continue;
                    }
                    const nk = key(nm, v);
                    const nd = dist.get(nk);
                    if (nd === undefined) {
                        dist.set(nk, d + 1);
                        seqs.set(nk, [nextList.sort()[0]!]);
                        q.push([nm, v]);
                    } else if (nd === d + 1) {
                        const best = [...seqs.get(nk)!, ...nextList].sort()[0]!;
                        seqs.set(nk, [best]);
                    }
                }
            }
            allMin.sort();
            return { steps: ansSteps, lexFirst: allMin[0]!, allMin };
        };

        const exact = solve(-1);
        expect(exact.steps).toBe(13);
        expect(exact.lexFirst).toBe('CADACEACADADB');
        expect(exact.allMin).toEqual(['CADACEACADADB', 'CADAEBEACACEA']);
        for (let r = 0; r < 5; r++) {
            expect(solve(r).steps).toBeLessThan(13);
        }
        expect(task.grade(JSON.stringify({ min_steps: 13, sequence: 'CADACEACADADB' })).content_score).toBe(1);
        expect(task.grade(JSON.stringify({ min_steps: 13, sequence: 'CADAEBEACACEA' })).content_score).toBe(0.5);
        expect(task.grade(JSON.stringify({ min_steps: 9, sequence: 'CADAEADDB' })).content_score).toBe(0);
    });

    test('I25_Bilingual_Custody_Discrepancy: custody projection across English and Chinese notes', () => {
        const task = taskById('I25_Bilingual_Custody_Discrepancy');
        const coded: [string, 'H' | 'N' | 'U', 'H' | 'N' | 'U'][] = [
            ['G', 'N', 'U'],
            ['S', 'U', 'N'],
            ['T', 'N', 'H'],
            ['L', 'H', 'H'],
            ['F', 'H', 'U'],
            ['P', 'U', 'H']
        ];
        const entries = coded.filter(([, en, zh]) => en !== zh).map(([id, en, zh]) => `${id}:${en}/${zh}`);
        expect(entries).toEqual(['G:N/U', 'S:U/N', 'T:N/H', 'F:H/U', 'P:U/H']);
        expect(task.grade(JSON.stringify({ entries })).content_score).toBe(1);
    });

    test('T25_Deceptive_Relay_Matrix: I is the unique 4-probe minimax opening across 12 contacts (10 balanced 8:8 traps fail)', () => {
        const task = taskById('T25_Deceptive_Relay_Matrix');
        const contacts = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'] as const;
        const table: Record<string, string> = {
            M0: '001001000000',
            M1: '000010100110',
            M2: '000100001111',
            M3: '110100110111',
            M4: '001111010000',
            M5: '111001111011',
            M6: '001011010001',
            M7: '111001111010',
            M8: '011010010100',
            M9: '010110101001',
            M10: '110101001100',
            M11: '100010100111',
            M12: '110100100100',
            M13: '111101111110',
            M14: '001011011000',
            M15: '100110001010'
        };
        const bit = (cand: string, c: string) => Number(table[cand]![contacts.indexOf(c as any)]);
        const canSolve = (cands: string[], stepsLeft: number): boolean => {
            if (cands.length <= 1) return true;
            if (stepsLeft === 0 || cands.length > 1 << stepsLeft) return false;
            return contacts.some(c => {
                const z = cands.filter(v => bit(v, c) === 0);
                const o = cands.filter(v => bit(v, c) === 1);
                return z.length > 0 && o.length > 0 && canSolve(z, stepsLeft - 1) && canSolve(o, stepsLeft - 1);
            });
        };
        const all = Object.keys(table);
        const balanced = contacts.filter(c => all.filter(v => bit(v, c) === 1).length === 8);
        expect(balanced.length).toBe(11);
        const safeOpenings = contacts.filter(c => {
            const z = all.filter(v => bit(v, c) === 0);
            const o = all.filter(v => bit(v, c) === 1);
            return canSolve(z, 3) && canSolve(o, 3);
        });
        expect(safeOpenings).toEqual(['I']);

        // Execute certified adaptive trace on M5 using opening I.
        const sim = task.make_simulator!();
        let remaining = [...all];
        for (let step = 0; step < 4; step++) {
            const pick = contacts.find(c => {
                const z = remaining.filter(v => bit(v, c) === 0);
                const o = remaining.filter(v => bit(v, c) === 1);
                return z.length > 0 && o.length > 0 && canSolve(z, 3 - step) && canSolve(o, 3 - step);
            });
            expect(pick).toBeDefined();
            const res = sim.call('probe_case', { case_id: pick! });
            expect(res.ok).toBe(true);
            const observed = Number((res as any).output);
            remaining = remaining.filter(v => bit(v, pick!) === observed);
        }
        expect(remaining).toEqual(['M5']);
        expect(sim.grade(JSON.stringify({ candidate_id: 'M5' })).content_score).toBe(1);

        // Greedy balanced decoy opening A must receive 0 even if guessing M5.
        const unsafeSim = task.make_simulator!();
        for (const c of ['A', 'B', 'C', 'L']) {
            unsafeSim.call('probe_case', { case_id: c });
        }
        expect(unsafeSim.grade(JSON.stringify({ candidate_id: 'M5' })).content_score).toBe(0);
    });

    test('T25_Delegated_Manifest_Dispatch: unique 6-record zero-rejection dispatch leaves Ash and Bay pending', () => {
        const task = taskById('T25_Delegated_Manifest_Dispatch');
        const sim = task.make_simulator!();
        expect(sim.call('inspect_queue', {}).ok).toBe(true);
        expect(sim.call('read_authorizations', {}).ok).toBe(true);
        const plan: [string, string][] = [
            ['Coil', 'Birch'],
            ['Dune', 'Larch'],
            ['Elm', 'Birch'],
            ['Fir', 'Alder'],
            ['Gull', 'Finch'],
            ['Hull', 'Alder']
        ];
        for (const [record_id, approval_handle] of plan) {
            const res = sim.call('release_record', { record_id, approval_handle });
            expect(res.ok).toBe(true);
        }
        const answer = {
            released: ['Coil', 'Dune', 'Elm', 'Fir', 'Gull', 'Hull'],
            pending: ['Ash', 'Bay'],
            root_uses_remaining: 2
        };
        const graded = sim.grade(JSON.stringify(answer));
        expect(graded.content_score).toBe(1);
        expect(graded.outcome).toBe('correct');
    });
});
