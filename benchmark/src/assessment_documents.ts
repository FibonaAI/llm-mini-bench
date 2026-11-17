import type { AssessmentGrade, AssessmentSimulator, AssessmentTask } from './assessment_tasks.ts';
import { assessment_data_expected } from './assessment_data.ts';

/** Declarative document investigation with bounded fetches and exact final fields. */
export const ASSESSMENT_DOCUMENTS_TASK_FORMAT = 'assessment-documents-v1';
type DocumentObject = Record<string, unknown>;
type DocumentConfig = { documents: Record<string, { content: unknown }>; expected: Record<string, unknown>; query_limit: number };
type DocumentHistory = { name: string; arguments: unknown; result: DocumentObject }[];
const object = (value: unknown): value is DocumentObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactFields = (value: DocumentObject, fields: string[]) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
function requireDocuments(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error('Assessment document task ' + reason); }

function documentConfig(value: unknown): DocumentConfig {
    requireDocuments(object(value) && exactFields(value, ['documents', 'expected', 'query_limit']), 'requires documents, expected fields and query limit');
    requireDocuments(object(value.documents) && Object.keys(value.documents).length > 0, 'requires at least one document');
    for (const [id, document] of Object.entries(value.documents)) requireDocuments(/^[A-Za-z][A-Za-z0-9_]*$/.test(id) && object(document) && exactFields(document, ['content']), 'has an invalid document: ' + id);
    requireDocuments(object(value.expected) && Object.keys(value.expected).length > 0, 'requires nonempty expected fields');
    requireDocuments(typeof value.query_limit === 'number' && Number.isSafeInteger(value.query_limit) && value.query_limit > 0, 'query limit must be a positive integer');
    return structuredClone(value) as DocumentConfig;
}

/** Strict schema for fetching one indexed document. */
export function assessment_documents_tools(): DocumentObject[] {
    return [{ type: 'function', name: 'fetch_document', description: 'Fetch the full content of one public document ID.', parameters: { type: 'object', properties: { document_id: { type: 'string' } }, required: ['document_id'], additionalProperties: false }, strict: true }];
}

/** Fixed document store; model text is graded only by the shared exact-field grader. */
export class DocumentAssessmentSimulator implements AssessmentSimulator {
    readonly config: DocumentConfig;
    history: DocumentHistory = [];
    invalid_attempts = 0;

    constructor(config: unknown) { this.config = documentConfig(config); }

    call(name: string, args: unknown): DocumentObject {
        let result: DocumentObject;
        if (this.history.length >= this.config.query_limit) {
            result = { ok: false, error: 'query_limit' }; this.invalid_attempts++;
        } else if (!object(args)) {
            result = { ok: false, error: 'arguments must be an object' }; this.invalid_attempts++;
        } else if (name === 'fetch_document' && exactFields(args, ['document_id']) && typeof args.document_id === 'string' && Object.hasOwn(this.config.documents, args.document_id)) {
            result = { ok: true, document_id: args.document_id, content: structuredClone(this.config.documents[args.document_id]!.content) };
        } else {
            result = { ok: false, error: 'unknown tool or invalid argument fields' }; this.invalid_attempts++;
        }
        this.history.push({ name, arguments: structuredClone(args), result: structuredClone(result) });
        return structuredClone(result);
    }

    grade(text: unknown): AssessmentGrade {
        const { grade_assessment_fields } = require('./assessment_tasks.ts') as typeof import('./assessment_tasks.ts');
        const result = grade_assessment_fields(text, assessment_data_expected(this.config.expected) as Record<string, unknown>);
        const used = this.history.some(call => call.name === 'fetch_document' && call.result.ok === true);
        const within = this.history.length <= this.config.query_limit && this.invalid_attempts === 0;
        result.tool_checks = { used_documents: used, within_query_limit: within, no_invalid_attempts: this.invalid_attempts === 0 };
        result.tool_calls = this.history.length;
        if (!within) result.outcome = 'query_limit';
        return result;
    }
}

/** Attach a document-investigation task without putting evidence rules in the runner. */
export function configure_assessment_documents_task(card: AssessmentTask, config: unknown): AssessmentTask {
    documentConfig(config);
    card.kind = 'tool';
    card.tools = assessment_documents_tools();
    card.make_simulator = () => new DocumentAssessmentSimulator(config);
    card.grade = () => ({ content_score: null, content_checks: {}, instruction_checks: {}, tool_checks: {}, outcome: 'ungradable', reason: 'Use the same document simulator instance that received real fetches.' });
    return card;
}
