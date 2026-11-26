import { DocumentAssessmentSimulator, assessment_documents_tools } from './assessment_documents.ts';
import { assessment_data_expected } from './assessment_data.ts';
import {
    assessment_exact_fields,
    assessment_result,
    grade_assessment_fields,
    is_assessment_object,
    type AssessmentGrade
} from './assessment_tasks.ts';

/** Document investigation with credit conditional on actually opening the cited evidence. */
export const ASSESSMENT_DOCUMENTS_V2_TASK_FORMAT = 'assessment-documents-v2';

/** The evidence protocol changes grading only, not the document fetch tool. */
export const assessment_documents_v2_tools = assessment_documents_tools;

function listedKeys(value: unknown, dictionary: Record<string, unknown>): value is string[] {
    return (
        Array.isArray(value) &&
        value.every(key => typeof key === 'string' && Object.hasOwn(dictionary, key)) &&
        new Set(value).size === value.length
    );
}

function gatedEvidenceByField(
    value: unknown,
    expected: Record<string, unknown>,
    documents: Record<string, unknown>,
    fallbackRequired: string[]
): Map<string, string[]> | null {
    if (listedKeys(value, expected)) return new Map(value.map(key => [key, [...fallbackRequired]]));
    if (!is_assessment_object(value)) return null;
    const entries = Object.entries(value);
    if (!entries.every(([key, docs]) => Object.hasOwn(expected, key) && listedKeys(docs, documents) && docs.length > 0)) return null;
    return new Map(entries.map(([key, docs]) => [key, [...(docs as string[])]]));
}

/** Keeps the original fetch budget semantics and grades evidence on this sample's own history. */
export class DocumentV2AssessmentSimulator extends DocumentAssessmentSimulator {
    private readonly entryDocument: string;
    private readonly requiredEvidence: string[];
    private readonly gatedFieldDocs: Map<string, string[]>;
    private readonly expected: Record<string, unknown>;

    constructor(value: unknown) {
        const fieldDocs =
            is_assessment_object(value) &&
            is_assessment_object(value.documents) &&
            is_assessment_object(value.expected) &&
            listedKeys(value.required_evidence_documents, value.documents)
                ? gatedEvidenceByField(value.evidence_gated_fields, value.expected, value.documents, value.required_evidence_documents)
                : null;
        if (
            !is_assessment_object(value) ||
            !assessment_exact_fields(value, [
                'entry_document',
                'documents',
                'query_limit',
                'required_evidence_documents',
                'evidence_gated_fields',
                'expected'
            ]) ||
            !is_assessment_object(value.documents) ||
            !is_assessment_object(value.expected) ||
            typeof value.entry_document !== 'string' ||
            !Object.hasOwn(value.documents, value.entry_document) ||
            !listedKeys(value.required_evidence_documents, value.documents) ||
            !fieldDocs
        )
            throw new Error('Assessment document v2 requires declared entry, evidence documents and answer fields');
        super({ documents: value.documents, query_limit: value.query_limit, expected: value.expected });
        this.entryDocument = value.entry_document;
        this.requiredEvidence = [...value.required_evidence_documents];
        this.gatedFieldDocs = fieldDocs;
        this.expected = assessment_data_expected(this.config.expected) as Record<string, unknown>;
    }

    override grade(text: unknown): AssessmentGrade {
        const okDocs = new Set(
            this.history.filter(call => call.name === 'fetch_document' && call.result.ok === true).map(call => call.result.document_id)
        );
        const openedEntry = okDocs.has(this.entryDocument);
        const hasEvidence = this.requiredEvidence.every(id => okDocs.has(id));
        const within = this.history.length <= this.config.query_limit && this.invalid_attempts === 0;
        const raw = grade_assessment_fields(text, this.expected);
        const checks = Object.fromEntries(
            Object.entries(raw.content_checks).map(([key, matched]) => {
                const requiredForField = this.gatedFieldDocs.get(key);
                return [
                    key,
                    matched && openedEntry && (!requiredForField || (within && requiredForField.every(id => okDocs.has(id))))
                ];
            })
        );
        // Abstention and incorrect assertions describe the submitted text, not missing evidence.
        const grade = raw.abstention_checks
            ? { ...raw, ...assessment_result(checks, raw.instruction_checks, raw.outcome === 'abstained' ? 'abstained' : null) }
            : raw;
        grade.tool_checks = {
            used_documents: okDocs.size > 0,
            opened_entry_document: openedEntry,
            fetched_required_evidence: hasEvidence,
            within_query_limit: within,
            no_invalid_attempts: this.invalid_attempts === 0
        };
        grade.tool_calls = this.history.length;
        return grade;
    }
}
