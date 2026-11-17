# Assessment 2.2 investigation answer certificates

These certificates support the independent Bun checks in `benchmark/tests/assessment_2_2_investigation_oracles.test.ts`. They establish answer validity, not empirical difficulty.

## E_Final_Scoped_Release_Evidence

n1 changes peak to 160. Its latency_max field is outside ops authority. n2 changes latency_max to 11 and recovery_min to 6; its mode field is outside qa authority and review-only is fixed. n3 has the wrong platform. n4 was not issued by review time even though its effective time is earlier. n5 has the wrong release. n6 is not effective yet. The effective requirements are therefore (160, 11, 6).

Only L1 is adequate latency evidence. L2's maximum 12 exceeds 11; L3's load 120 is below 160. L1 directly supports (c1, k1), T1 adds (c1, k2), and T2 adds (c2, k1). It cannot reach (c2, k2): after T1 the condition of T2 is false, while after T2 the condition of T1 is false. Thus A, C, D have latency evidence; B does not.

R1 and R3 are adequate recovery evidence. R2 has too few cold restarts, R4 has the wrong restart kind, and R5 loses a record. R1 supports (c1, p1); T3 adds (c1, p2), T4 adds (c2, p1), also directly supported by R3. The same noncommuting-condition argument excludes (c2, p2). Thus A, B, D have recovery evidence; C does not.

The intersection is A, D. Their costs are 4 and 6, so A is selected. B lacks only latency; C lacks only recovery. The operator's request neither changes the contract nor creates a measurement or transfer certificate. Ignoring that request must not discard L1-L3.

## T_Final_Reserve_Change_Dispatch

Let a be clear's settled reserve and b be returns' settled reserve. Exactly 8-a clean units can leave clear. Returns cannot contribute a clean unit, and contamination never clears. Therefore clinic cannot exceed min(6, 8-a).

This bound is attainable: move enough clean stock through relay to clinic before any contaminated stock enters relay. Any excess clean stock can go through relay to quarantine. Then move 7-b contaminated units from returns through relay to quarantine. Capacities and the maximum transfer allow these moves in chunks of at most 6. Quarantine receives at most 6 units in any branch, below capacity 10.

Every goal leaves clear=a, returns=b, relay=0, clinic=min(6, 8-a), and quarantine=15-a-b-clinic. Because 7-b is positive in all branches, returns, relay, and quarantine are exactly the tainted nodes. Those physical end states are unique; action paths are not.

The frozen instance is a=3, b=2. Thus clinic receives 5, not the requested 6; quarantine receives 5. Its seven-call witness is inspection, clear-conflict, clear-to-relay 5, relay-to-clinic 5, returns-conflict, returns-to-relay 5, relay-to-quarantine 5. Current revisions come from each actual response.

All four instances have identical prompt and initial inspect result. On first touching clear, feedback distinguishes a=1 from a=3; on first touching returns, feedback distinguishes b=2 from b=4. All four final stock vectors differ. A fixed final report cannot satisfy them all, and a fixed unobserved transfer quantity can overspend the new reserve. The feedback controller uses only response state, not hidden configuration. This is a fixed hidden-state instance, not a claim of fresh randomness per call.

Introducing contaminated stock into relay before completing clean service permanently closes the only path to clinic, even after relay is emptied. The simulator permits that strategic mistake but rejects a subsequent contaminated transfer to clinic. This failure is tested.

## I_Final_Reconcile_Uncertain_Identity

The true readings for r1..r6 are 4, 8, 6, 9, 5, 7. The calibration facts apply, while the proposed identity mapping and report request are outside calibration authority. The current request uses unit IDs, strict greater-than, and all compatible one-to-one assignments.

E can receive only r4, r5, r6, whose readings 9, 5, 7 all exceed E's limit 4. E is therefore certain. F can receive only r5 or r6, readings 5 or 7, neither strictly above F's limit 7, so F is never possible.

r2 must belong to A or B, and 8 exceeds both limits. Every other receipt allowed for A or B is r1=4 or r3=6, both at or below their limits. Thus exactly one of A, B needs retesting in every assignment. The priority bounds are [1, 1].

E plus exactly one of A, B forces at least two retests. At most those two plus C and D can need retesting, giving an upper bound of four. The receipt-to-unit order C, A, B, E, D, F is valid and fails exactly A, E, attaining two. Order A, B, C, D, E, F is valid and fails B, C, D, E, attaining four.

The minimum witness makes B, C, D pass, while the maximum witness makes A pass. Together with permanent F safety, no unit except E is certain. The maximum witness makes B, C, D, E possible, and the minimum witness makes A possible, so possible is A, B, C, D, E. These witnesses establish every quantifier claim without selecting a preferred hidden identity.

## Resource scoring

The existing resource-v1 grader includes observed_network, used_conflict_feedback, and no_invalid_attempts in its content checks. It ALSO records separate instruction and tool checks. These inherited semantics are stated on the card; the candidate does not pretend the content score is purely a final-answer score.
