# Bank Files

[中文](README.zh.md)

Assessment 2.0 and Assessment 1.0 are the official released question banks served side-by-side:

- [assessment-2.0.json](assessment-2.0.json) & [assessment-2.0.questions.json](assessment-2.0.questions.json): Assessment 2.0 manifest and 12-task export (`task_sha256: 84feeda2…24a3`), using minimal-prompt `assessment-exact-fields-v1` tasks and evidence-gated `v2` interactive simulators
- [assessment-1.0.json](assessment-1.0.json) & [assessment-1.0.questions.json](assessment-1.0.questions.json): Assessment 1.0 manifest and 12-task export (`task_sha256: d58ddb12…fed8`), using `assessment-exact-fields-v1` and `v1` interactive simulators

The loader is `src/assessment_bank.ts`. It loads the requested manifest plus question-file path and validates every task snapshot and source digest. `src/assessment_data.ts` implements shared exact-field data grading, `src/assessment_interactive.ts` binds the `v1` in-memory simulators, and `src/assessment_interactive_v2.ts` binds the `v2` evidence-gated simulators atop the shared simulator state machines. Data-defined expected answers and simulator configurations participate in each bank's task hash.

Manifest source paths resolve relative to the benchmark root, `benchmark/`. Each manifest pins `src/assessment_tasks.ts`, `src/assessment_json.ts`, and `src/assessment_data.ts`, plus the interactive simulator modules in `extension_sha256`.

See the [bank guide](../../docs/ASSESSMENT_BANK.md) for grading and calibration, and the [maintenance guide](../../AGENTS.md) for validation requirements.
