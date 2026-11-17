# Assessment 2.2 inference certificates

These are independent mathematical derivations of the answers, checked against the fixed enumerative author oracle. They are not an independent human/agent review and do not establish empirical difficulty. All statements use only definitions in the cards. No outside classification theorem or numerical optimizer is required.

## F_Marginal_Compatibility

Write a, b, c for the common disagreement probabilities within ABC, for DE, and across the two groups. At retention t,

    a = 1/2 + t/6,  b = 1/2 + t/2,  c = 1/2 - t/10.

### Global obstruction and attainability

For one realized assignment let k=A+B+C, l=D+E, and s=k-l. The sum of within-group disagreements minus cross-group disagreements is exactly

    k(3-k) + l(2-l) - [k(2-l)+(3-k)l] = s(1-s) <= 0.

The inequality uses that s is an integer. Taking expectations gives

    3a + b - 6c = -1 + (8/5)t <= 0,

so t <= 5/8. This applies to arbitrary joint distributions, without symmetry assumptions. At the original t=1 the specification is therefore impossible. All three-variable marginals alone are insufficient: their strongest restriction here is t <= 5/7, from a triangle with D, E and one of A, B, C; the ABC triangle only requires t <= 1. For example t=2/3 satisfies every triangle disagreement inequality but violates the five-variable inequality.

For realizability and event bounds, average a distribution under all permutations within ABC, all permutations within DE, and simultaneous complementation of all five bits. Every stated constraint and each objective is invariant under these operations. Averaging preserves each one's value, so restricting the optimization to the resulting invariant distributions loses no extrema. This is a proof of the reduction, not an extra assumption about the variables.

There are six orbits. Let w0,..., w5 denote their TOTAL probability masses. Orbit j is the uniform distribution over all assignments with counts (k, l) as listed, together with their complements:

| j | Representative (k, l) | Within ABC a | DE b | Cross c |
|---|---|---|---|---|
| 0 | (0, 0) | 0 | 0 | 0 |
| 1 | (0, 1) | 0 | 1 | 1/2 |
| 2 | (0, 2) | 0 | 0 | 1 |
| 3 | (1, 0) | 2/3 | 0 | 1/3 |
| 4 | (1, 1) | 2/3 | 1 | 1/2 |
| 5 | (1, 2) | 2/3 | 0 | 2/3 |

This explicitly defines an atomic distribution for any nonnegative weights summing to one. Complementation makes every individual bit fair. At t=5/8 the weights

    (3/32, 0, 0, 3/32, 13/16, 0)

give exactly a=29/48, b=13/16, c=7/16. Thus the maximum feasible t is **5/8**, attained. Mixing this distribution with five independent fair bits realizes every t from 0 through 5/8, although only the maximum is requested.

### Sharp bounds at t=1/2

Here a=7/12, b=3/4, c=9/20. The equalities imply

    w0+w1+w2 = 1/8,
    w1+w4 = 3/4,
    w1+3w2+w5 = 1/10.

Since weights are nonnegative, 0 <= w1+w2 <= 1/10. Therefore

    P(all five equal) = w0 = 1/8-w1-w2 in [1/40, 1/8].

The event ABC equal and DE equal consists of orbits 0 and 2. Also P(D=E)=1/4. Consequently

    P(A=B=C | D=E) = (w0+w2)/(1/4) = 1/2-4w1 in [1/10, 1/2].

The following two witnesses attain all four endpoints:

| Weights (w0, w1, w2, w3, w4, w5) | All equal | Conditional triple equal |
|---|---|---|
| (1/40, 1/10, 0, 9/40, 13/20, 0) | 1/40 | 1/10 |
| (1/8, 0, 0, 1/40, 3/4, 1/10) | 1/8 | 1/2 |

All table rows expand to nonnegative probabilities on the 32 assignments and satisfy each of the ten separate pair constraints and all five individual marginals. The verification script checks those atomic facts, not just the orbit averages.

## F_Private_Recommendations

Use unconditional masses on state/action-profile pairs, not posterior probabilities. A player's own recommendation defines its information in the private regimes; the full pair defines its information in the public regime.

### Why symmetry is legitimate for these objectives

Given any admissible rule, average it with the rule obtained by exchanging players. The state prior, the linear obedience inequalities, and both objectives (exactly one and both active) are preserved. Hence a symmetric optimum exists, and the secondary optimum can also be found symmetrically. This does not assume that the submitted design must be symmetric. In particular, every asymmetric optimal rule has a symmetric average with the SAME probability of both acting.

For an averaged rule write the unconditional masses as

| State | 00 | 10 | 01 | 11 |
|---|---|---|---|---|
| H | x | y | y | z |
| L | u | v | v | w |

They satisfy x+2y+z=2/5 and u+2v+w=3/5. Obedience to recommendation 1 requires

    A = 2y+4z-3v-w >= 0.

Obedience to recommendation 0 requires

    B = 3u+v-2x-4y >= 0.

These are unnormalized conditional expected payoff comparisons, valid also when a recommendation has zero probability. Since only two actions exist, checking the other pure action also checks every randomized unilateral deviation.

Substituting the state-mass equalities gives

    6y+3v+4x+w <= 8/5,
    4y+5v+2x+3w <= 9/5.

Multiply the first inequality by 1/9 and the second by 1/3, then add:

    2(y+v) + (10/9)(x+w) <= 7/9.

Therefore exactly-one probability is at most 7/9. Equality requires x=w=0 and both inequalities tight, because both multipliers are positive. Solving yields

    x=0, y=13/90, z=1/9, u=1/9, v=11/45, w=0.

These masses are nonnegative, have the required prior, and make both obedience inequalities equalities. Thus **7/9** is attained. The probability of both acting is **1/9** for the symmetric optimum. Since symmetrizing any optimal rule preserves this probability and the symmetric optimizer is unique, every optimal rule has this same both-active probability; its minimum is therefore **1/9** as well.

To implement the witness as conditional recommendation probabilities, divide each H mass by 2/5 and each L mass by 3/5. The resulting rows are

    H: (0, 13/36, 13/36, 5/18)
    L: (5/27, 11/27, 11/27, 0).

Each row sums to one. Tie obedience, explicitly stipulated in the card, makes this witness admissible.

### Blind private recommendations

Here the expected state contribution conditional on any recommendation is the prior mean 2*(2/5)-3*(3/5)=-1. Let symmetric unconditional profile masses be (q0, q1, q1, q2). Obedience to 1 requires q2>=q1; obedience to 0 requires q0>=q1. Hence

    1=q0+2q1+q2 >= 4q1,

so exactly-one probability 2q1 is at most **1/2**. Independent fair recommendations, giving each of the four profiles probability 1/4 independently of the state, attain it. This witness permits correlation in the optimization; independence is merely one attaining construction.

### Informed public recommendations

If the publicly observed pair is 10 or 01 with positive probability, let m be the common conditional mean of theta. The active player's obedience requires m>=0; the inactive player's obedience requires m+2<=0. These cannot both hold. Therefore every admissible public rule puts zero mass on exactly-one profiles and its maximum is **0**. Always recommending 00 is admissible because the prior mean is -1, proving feasibility.

## F_Distributed_Guessing

View all binary words as the vertices of a five-dimensional cube; two words are adjacent when they differ in one coordinate. This graph is a proof device, not an assumption or a fact needed from external sources.

### Local rules are equivalent to covering the cube by losing vertices

For any permitted deterministic protocol let D be its losing assignments. If an assignment x wins, at least one player i guesses correctly. At x with bit i flipped, player i sees the same view and makes the same guess, now incorrectly. That adjacent assignment belongs to D. Thus every vertex either belongs to D or has a neighbor in D: the closed radius-one neighborhoods of D cover the cube.

Conversely, given any such covering set D, define each player's local rule using the two full assignments consistent with its view. If exactly one is in D, guess the own-bit value of the other; if both or neither are in D, PASS. Outside D a covering neighbor guarantees at least one correct guess, and every guess is correct. Inside D any guesses are wrong; if nobody guesses, the assignment still loses. Thus the winning set is exactly the complement of D. This also proves that invariant covering sets yield rules with the corresponding bit-complement or participant-permutation symmetry.

### Seven losing vertices are necessary

One closed neighborhood has six vertices, so at least six centers are needed to cover all 32. Suppose exactly six centers suffice. Let a be their number of even-parity words; the number of odd centers is 6-a. Covering the 16 even vertices requires

    a+5(6-a)>=16,

and covering the odd vertices requires

    5a+(6-a)>=16.

With integer a, these force a=3: three centers in each parity class.

The three even centers have 15 open-neighborhood incidences in the odd class. Together with the three odd centers they must cover 16 odd vertices, so the union of the even centers' open neighborhoods must contain at least 13 vertices. Distinct same-parity centers are at distance 2 or 4. A distance-2 pair has exactly two common neighbors; a distance-4 pair has none. If at least two pairs in a triple have distance 2, its neighborhood union has at most 11 vertices (if exactly two pairs, their triple intersection is empty; if three pairs, subtract six pair intersections and add a triple intersection of at most two). So there is at most one distance-2 pair.

There must also be at least one distance-2 pair: after translating one center to 00000, two other centers both at distance four from it have weight four and distance two from each other. Hence exactly one pair has distance two and the other two distances are four. Up to coordinate permutation and translation, the three even centers are

    00000, 00011, 11101.

Their open neighborhoods cover 13 odd vertices. The remaining three odd vertices are exactly

    01110, 10110, 11010.

All three must therefore be odd centers. But every pair of these is distance two, contradicting the same neighborhood requirement applied with the two parity classes reversed. Six centers cannot suffice; at least seven are necessary.

Seven suffice. One covering set, with binary words displayed most-significant bit first, is

    00000, 00001, 00010, 01111, 10111, 11011, 11100.

The verification script explicitly checks all 32 closed neighborhoods and constructs and executes the resulting local rules. Therefore the unrestricted maximum is **32-7=25**.

### Complement-equivariant rules

Complement equivariance implies that the losing set is closed under simultaneous complementation. No five-bit word equals its complement, so its size is even. The unrestricted lower bound of seven becomes at least eight. Eight suffice with

    {00000, 00001, 00010, 00011, 11100, 11101, 11110, 11111}.

This is the set of words whose first three bits are all equal, with the last two arbitrary. Any length-three binary word is within distance one of 000 or 111. Thus it covers the five-cube, and it is closed under complementation. The constructed local protocol is complement-equivariant on every view. Its maximum is **24**.

### Anonymous rules

The losing set for an anonymous rule is invariant under coordinate permutations, so it is a union of whole weight layers. Layer sizes are (1, 5, 10, 10, 5, 1), and a chosen layer covers only its own weight and adjacent weights. Covering the six weights needs at least ten total vertices:

- If neither endpoint layer 0 nor 5 is chosen, layers 1 and 4 must both be chosen, costing ten.
- If just one endpoint layer is chosen, the opposite endpoint forces its neighboring layer (cost five), and one more layer of cost at least five is needed to cover weight 2 or 3, for at least eleven.
- If both endpoint layers are chosen, covering weights 2 and 3 costs at least ten more (one of layers 2/3, or both 1 and 4), for at least twelve.

Layers 1 and 4 attain ten. Equivalently, a direct anonymous rule outputs (0, 1, PASS, 0, 1) when the number of observed ones is (0, 1, 2, 3, 4). It succeeds exactly on weights 0, 2, 3, 5, a total of **22** assignments. The verifier also enumerates all 3^5 anonymous rules, independently of the covering argument.

## What the computational checks establish

`benchmark/tests/assessment_2_2_inference_oracles.test.ts` checks these certificates using integer common denominators. It expands the extremal distributions to all 32 assignments, verifies every marginal and the global inequalities, checks the recommendation dual on all eight atoms and every unilateral deviation of the witnesses, exhausts the parity obstruction to six cube centers, executes the attaining local rules on all assignments, checks complement equivariance on every view, and enumerates all 243 anonymous rules. It grades the derived answers through the actual bank loader and rejects semantic mutations. The development bundle additionally used exact rational vertex enumeration in a fixed offline author oracle; Python is not required by the repository or its tests. Expected answers are fixed in the cards and are not changed by model responses.
