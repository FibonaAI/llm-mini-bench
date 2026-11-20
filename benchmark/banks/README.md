# Bank Files

[中文](README.zh.md)

Assessment 1.0 is the production question bank:

- [assessment-1.0.json](assessment-1.0.json): production manifest with 12 tasks across six domains, stable task order/hash, exact-field and simulator grading descriptors, and pinned grader/simulator source hashes
- [assessment-1.0.questions.json](assessment-1.0.questions.json): serializable 1.0 task prompts, exact answer descriptors, `submit-answer-tool-v1` schemas, and fixed tool configurations

The loader is `src/assessment_bank.ts`. It loads the manifest plus question-file path and validates every task snapshot and source digest. `src/assessment_data.ts` implements shared exact-field data grading, and `src/assessment_interactive.ts` binds the fixed in-memory document, black-box diagnosis, and delegated-release simulators. Data-defined expected answers and simulator configurations participate in the task hash (`d58ddb12…fed8` for production 1.0).

Manifest source paths resolve relative to the benchmark root, `benchmark/`. Each manifest pins `src/assessment_tasks.ts`, `src/assessment_json.ts`, and `src/assessment_data.ts`, plus the interactive simulator modules in `extension_sha256`.

See the [bank guide](../../docs/ASSESSMENT_BANK.md) for grading and calibration, and the [maintenance guide](../../AGENTS.md) for validation requirements.
