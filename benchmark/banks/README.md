# Bank Files

[中文](README.zh.md)

Assessment 1.0 is the only production/default bank. Assessment 2.0, 2.1, 2.2 and 2.3 are experimental-unvalidated calibration banks and are never selected by default.

- [assessment-1.0.json](assessment-1.0.json): production manifest with 14 tasks, stable task order/hash, named grading descriptors, shared source hashes, and evidence paths
- [assessment-1.0.questions.json](assessment-1.0.questions.json): unchanged serializable 1.0 task prompts
- [assessment-2.0.json](assessment-2.0.json): experimental 14-task manifest retained for design auditing; acceptance-only feedback cannot identify arbitrary hidden state names, so its named-state scores are not valid capability measurements
- [assessment-2.0.questions.json](assessment-2.0.questions.json): serializable 2.0 task prompts
- [assessment-2.1.json](assessment-2.1.json): balanced experimental manifest with 14 tasks across reasoning, code, context, instruction, and tool use
- [assessment-2.1.questions.json](assessment-2.1.questions.json): serializable 2.1 task prompts
- [assessment-2.2.json](assessment-2.2.json): compact multidisciplinary experimental manifest with frozen grading and source hashes
- [assessment-2.2.questions.json](assessment-2.2.questions.json): complete 2.2 prompts, exact answer descriptors and fixed tool configurations
- [assessment-2.3.json](assessment-2.3.json): 12-task balanced six-domain experimental manifest with frozen grading and source hashes
- [assessment-2.3.questions.json](assessment-2.3.questions.json): complete 2.3 prompts, exact answer descriptors and fixed tool configurations

The loader is `src/assessment_bank.ts`. Every version uses the same manifest plus question-file path; there are no bank-version loader branches. `src/assessment_data.ts` implements shared exact-field data grading and adapters to named built-in oracles and fixed simulators. `src/assessment_resource.ts` provides the declarative interactive resource-network format and simulator. `src/assessment_dfa.ts` provides the hidden-DFA adaptive-query simulator. Data-defined expected answers and resource configurations participate in task hashes, while the named 1.0 descriptors preserve its original task snapshots and `6e089b1c…684d` task hash.

Manifest source and evidence paths are relative to the benchmark root, `benchmark/`. Each manifest pins the four original grader modules, the shared strict JSON parser, the data-grading adapter, the declarative resource simulator, and the hidden-DFA simulator. Historical baselines retain their original source maps unchanged. Revision labels in task implementations do not define additional bank versions.

See the [bank guide](../../docs/ASSESSMENT_BANK.md) for grading and calibration, and the [maintenance guide](../../AGENTS.md) for validation requirements.
