# Assessment 2.2 code answer certificates

These certificates cover the three code tasks in `benchmark/banks/assessment-2.2.questions.json`. They establish answers, not model difficulty. The independent Bun oracles are in `benchmark/tests/assessment_2_2_code_oracles.test.ts`.

## 1. Aliased rotation fusion

Write p, q, r, s for the initial contents of distinct cells 0, 1, 2, 3. Substitution in the displayed statements gives the following complete certificate. Each tuple lists final distinct cells in cell-number order.

| Pattern | Reference | Transformed |
| --- | --- | --- |
| 0000 | (p) | (p) |
| 0001 | (-q, p) | (p, p) |
| 0010 | (q, -p) | (q, p) |
| 0011 | (p, q) | (p, q) |
| 0012 | (p, -r, q) | (p, -r, q) |
| 0100 | (-q, p) | (p, p) |
| 0101 | (-p, -q) | (-q, p) |
| 0102 | (-r, p, -q) | (-r, p, p) |
| 0110 | (p, q) | (q, p) |
| 0111 | (-q, p) | (-q, q) |
| 0112 | (-q, -r, p) | (-q, p, q) |
| 0120 | (r, p, q) | (r, p, q) |
| 0121 | (-q, r, -p) | (-q, r, -q) |
| 0122 | (-q, p, r) | (-q, p, r) |
| 0123 | (-q, p, -s, r) | (-q, p, -s, r) |

These are all 15 partitions of four references. Equality of the displayed signed coordinates is necessary and sufficient for equality for every rational initial heap. This gives the six equivalent patterns 0000, 0011, 0012, 0120, 0122, 0123. A difference between signed coordinate expressions has a rational witness; equality on a special initial heap is insufficient.

For example, 0110 has c=b, d=a. The reference rotations cancel and leave (p, q); the transformed assignments leave (q, p). It is an incorrect bijection, not information loss. Conversely, 0102 maps (p, q, r) to (-r, p, p), losing q.

The unequal patterns 0102, 0112, 0121 have respectively just the one equal pair ac, bc, bd. Any sufficient conjunction of disequalities must prohibit each of those patterns. For each pattern, the only possible prohibiting conjunct is its sole equal pair. Thus every sufficient guard contains ac, bc, bd. This guard admits exactly 0011, 0012, 0120, 0122, 0123, all equivalent by the table. It is therefore the unique inclusion-minimal guard. The additional safe pattern 0000 cannot be admitted by a sufficient conjunction of disequalities: it satisfies only the empty guard, which admits unsafe patterns too.

Every transformed output coordinate is a signed copy of one initial coordinate. Its rank is therefore the number of distinct initial symbols appearing in its tuple. Exactly 0001, 0100, 0102, 0111, 0112, 0121 omit an initial symbol; each omits one. The maximum kernel dimension is one. This rank certificate is independent of the author's rational Gaussian elimination.

## 2. Erased token batching

The reference language contains concatenations of the six displayed tokens. Since every token has length at least two, every accepted word of length at most nine has some tokenization of at most four tokens. Enumerating these finitely many token sequences and identifying equal concatenations gives the following complete length certificate. The independent certificate generator constructs sequences first; the author oracle instead consumes input prefixes and retains state by last mode.

| Bit length | Distinct reference words | Distinct optimized words |
| --- | ---: | ---: |
| 0 | 1 | 1 |
| 1 | 0 | 0 |
| 2 | 2 | 2 |
| 3 | 2 | 2 |
| 4 | 4 | 4 |
| 5 | 6 | 6 |
| 6 | 10 | 10 |
| 7 | 16 | 16 |
| 8 | 26 | 26 |
| 9 | 42 | 38 |

The four missing length-nine words and their COMPLETE tokenizations are:

- 010110010: X01 X01 Y10 X010; X01 Y0110 X010.
- 011011001: X01 Y101 X1001; X01 Y101 Y10 X01.
- 100100110: Y10 X010 Y0110; Y10 X010 X01 Y10.
- 101001101: Y10 Y10 X01 Y101; Y10 X1001 Y101.

All eight tokenizations have exactly two switches. The sequence-generation certificate verifies that there are no additional tokenizations and no shorter missing words. The generator's depth bound follows from the prompt's token lengths, rather than an arbitrary search horizon. The Bun oracle checks the per-length counts, all missing words and the probe result.

For probe 0110010110, all six tokenizations are:

| Tokenization | Switches |
| --- | ---: |
| X01 X1001 X01 Y10 | 1 |
| X01 X1001 Y0110 | 1 |
| X01 Y10 X01 X01 Y10 | 3 |
| X01 Y10 X01 Y0110 | 3 |
| Y0110 X01 X01 Y10 | 2 |
| Y0110 X01 Y0110 | 2 |

Thus the minimum is one and the total count is six. Different valid parses are all represented; no single parse is privileged by the grading descriptor.

For the infinite family let B=010010010101101101=(010)^3(101)^3. Its natural parse is three X tokens followed by three Y tokens. Concatenating n such parses uses exactly 2n-1 switches, giving an upper bound.

For the matching lower bound, a stream consisting only of Y tokens cannot contain the four-bit window 0010. The only Y token starting with 0 is 0110; any 00 in a Y-only stream must cross a token boundary and is followed by 11, not 10. Similarly, an X-only stream cannot contain 1101: a boundary 11 must enter token 1001 and is followed by 00, not 01.

Each copy of B has window 0010 at offsets 2..5 and window 1101 at offsets 11..14, with zero-based offsets. Hence any full tokenization must contain an X token intersecting the first window and a Y token intersecting the second. Across copies these forced mode occurrences alternate between X and Y. The windows are separated far enough that, with maximum token length four, no token can intersect two consecutive selected windows. They therefore force at least 2n-1 switches in every tokenization. Combined with the natural parse, the exact formula is 2n-1 for every n>=1. Checking n=1..24 is only a supplementary regression; it is not the proof of the universal claim.

## 3. Snapshot serial witnesses

Direct Boolean substitution gives the snapshot map F(x, y, z)=(y AND z, (NOT x) OR z, x XOR y). Independently substituting each of the six serial compositions gives this complete certificate:

| Initial xyz | Snapshot final | Matching orders, final only | Matching orders, including reads |
| --- | --- | --- | --- |
| 000 | 010 | ACB, CAB, CBA | ACB, CAB |
| 001 | 010 | ACB, CAB, CBA | none |
| 010 | 011 | ABC, ACB, BAC | ABC, BAC |
| 011 | 111 | BCA, CAB, CBA | BCA, CBA |
| 100 | 001 | BCA | none |
| 101 | 011 | ABC, CAB | none |
| 110 | 000 | BAC, CBA | none |
| 111 | 110 | ABC, BAC | ABC, BAC |

For example, with input 100, BCA executes B: y=0, C: z=1, A: x=0 and reaches 001. Its reads differ from the snapshot, since A now sees z=1. Checking the other five orders shows that BCA is the sole final-state match there. As another check, at 000, CBA reaches 010 but A reads (1, 0) instead of snapshot (0, 0).

Every row has a final-state match, so final_state_failures is empty. Exactly 001, 100, 101, 110 lack a read-observation match.

For a complete portfolio proof, input 100 forces BCA into every portfolio. Input 111 requires ABC or BAC. Consider these exhaustive cases:

1. ABC is included and BAC is not: input 110 forces CBA. {ABC, BCA, CBA} already covers all rows, so any additional member would violate minimality.
2. BAC is included and ABC is not: input 101 forces CAB. {BAC, BCA, CAB} already covers all rows.
3. Both ABC and BAC are included: input 000 still needs ACB, CAB or CBA. CAB would contain the sufficient set from case 2; CBA would contain the sufficient set from case 1. For a new inclusion-minimal portfolio the choice must be ACB, giving {ABC, ACB, BAC, BCA}.

Each of these three sets is inclusion-minimal by the same forcing rows. The four-order set is not redundant simply because other covers use three orders.

Finally, each bit is necessary for a deterministic observation-based scheduler. If x is hidden, inputs 000 and 100 are indistinguishable, but their matching-order sets are disjoint. If y is hidden, use 100 and 110. If z is hidden, use 100 and 101. These pairs remain indistinguishable even if all other bits are observed. Observing xyz suffices by selecting any listed matching order for the known row. Thus xyz is the unique minimal observation set.

## Validation boundaries

The cards use three or four top-level exact semantic fields, with no privileged arbitrary witness. Canonical sorting is explicitly part of the prompts. The existing grader accepts equivalent rational spellings for numeric fields and ignores JSON object-key order; the tests exercise both. Noncanonical array order is not an alternative answer to these prompts. Extra top-level keys fail the instruction channel while leaving the existing content-score behavior unchanged.

The new cards change prompts and expected answers, so their scores are not directly comparable with historical Assessment 1.0, 2.1, or the earlier seven-candidate calibration. Production bank snapshots and historical evidence are unchanged. These certificates do not depend on model observations. Formal correctness, finite completeness certificates and mutation rejection do not establish strong-model discrimination.
