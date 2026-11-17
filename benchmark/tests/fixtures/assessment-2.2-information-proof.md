# Assessment 2.2 private-information proof

The answer was frozen before live requests. `benchmark/tests/assessment_2_2_information_oracle.test.ts` evaluates information cells directly; this separate derivation works by hand partitions.

Write abc for an ordered triple. There are eighteen equally likely worlds: 012, 013, 021, 023, 031, 032, 102, 103, 120, 130, 201, 203, 210, 230, 301, 302, 310, 320.

## Private bit execution

Alice's first yes excludes only 201 and 203. These share her observation a=2 and b<c=true, but disagree on a<c. Every other Alice information cell has a fixed truth value.

Within the remaining sixteen worlds, every Bob b-cell contains at least two different a values. His no therefore removes nothing. Cara knows the truth value when c=0 (always false) and when c=3 (always true). With c=1 or c=2 she has both possibilities. Her no leaves exactly:

- c=1: 021, 031, 301;
- c=2: 012, 032, 102, 302.

Thus the public posterior is uniform over seven worlds; five have a<c, giving 5/7.

Afterward Bob's cells are:

- b=0: 102, 301, 302 (does not know a);
- b=1: 012 (knows a=0);
- b=2: 021 (knows a=0);
- b=3: 031, 032 (knows a=0).

The actual world 032 puts Bob in the last cell, so he now knows a=0 despite his earlier no. Four of the seven public worlds have a Bob who knows a, giving 4/7.

Actual Alice sees a=0 and b<c=false. Her remaining cell is 021, 031, 032. Bob knows a=0 in all three. Thus Alice knows that Bob knows a even though she still cannot distinguish his observation b=2 from b=3.

## Public bit counterfactual

The actual public bit is false. The initial possible worlds are 021, 031, 032, 120, 130, 210, 230, 310, 320. Alice knows a<c in every one of her cells: it is true for a=0 and false for a=1, 2, 3. Her yes removes nothing.

For b=1, Bob considers a=2 or 3. For b=2 he considers a=0, 1, 3. For b=3 he considers a=0, 1, 2. Bob says no in all nine worlds. His no also removes nothing.

Cara knows a<c for each c: c=0 implies false, while c=1 and c=2 imply true. Her answer is yes. The counterfactual transcript is therefore [true, false, true], not the original [true, false, false]. It leaves all nine public-bit worlds. Revealing the bit changes the informational meaning of the last announcement; one cannot reuse the private-bit posterior.

## Measurement and ambiguity checks

The examiner's actual world is explicitly not public information. All agents know that Alice privately receives a bit, but only Alice initially knows its value. Speakers answer at their turn; requested final beliefs are evaluated after all turns. The counterfactual regenerates announcements rather than conditioning on an impossible fixed transcript. Deterministic announcements and the uniform prior justify uniform posterior weights. The possible-world oracle covers every world, not only the actual path. No external domain fact, approximate numerical tolerance or assessed-model code is required. This is still a small synthetic logical task and may remain easy for Sol; no empirical difficulty claim is made.
