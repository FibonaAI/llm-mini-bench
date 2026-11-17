import type { AssessmentGrade, AssessmentTask } from './assessment_tasks.ts';

/** Knowledge card revision; fixed sources are never fetched during grading. */
export const ASSESSMENT_KNOWLEDGE_VERSION = 'assessment-knowledge-0.1';
/** Date of author verification of the cited primary sources. */
export const KNOWLEDGE_SOURCE_VERIFIED_AT = '2026-11-10';

/** Generate only finite parenthetical combinations of synonymous amino acid labels. */
export function _amino_acid_aliases(full_name: string, short_name: string, letter: string, chinese_names: string[]): Set<string> {
    const names = [full_name, short_name, letter], aliases = new Set([...names, ...chinese_names]);
    for (const left of names) for (const right of names) if (left !== right) aliases.add(`${left} (${right})`);
    aliases.add(`${full_name} (${short_name}, ${letter})`);
    aliases.add(`${full_name} (${short_name}/${letter})`);
    return aliases;
}
/** Frozen NCBI transl_table=3 internal codon aliases, not standard-code assumptions. */
export const GENETIC_CODE_EXPECTED = {
    AUA: _amino_acid_aliases('Methionine', 'Met', 'M', ['甲硫氨酸', '蛋氨酸']),
    CUA: _amino_acid_aliases('Threonine', 'Thr', 'T', ['苏氨酸']),
    UGA: _amino_acid_aliases('Tryptophan', 'Trp', 'W', ['色氨酸']),
};
/** Frozen whole-field treaty aliases; no substring or keyword matching. */
export const TREATY_EXCEPTIONS_EXPECTED = {
    status: new Set(['void', 'invalid', 'null and void', 'void ab initio', 'absolutely void', '无效', '自始无效']),
    performance_principle: new Set(['good faith', 'in good faith', 'bona fide', '善意', '善意履行', '诚信履行']),
    boundary_exception_allowed: false,
};
/** RFC 2308 cache keys differ for NXDOMAIN and NODATA. */
export const DNS_KEY_FIELDS = {nxdomain_key: new Set(['QNAME', 'QCLASS']), nodata_key: new Set(['QNAME', 'QTYPE', 'QCLASS'])};
/** Closed phrases for minimum of the two named SOA fields. */
export const DNS_TTL_PHRASES = new Set([
    'the smaller of soa ttl and soa.minimum', 'the smaller of soa.minimum and soa ttl',
    'minimum of soa ttl and soa.minimum', 'minimum of soa.minimum and soa ttl',
    'the minimum of soa ttl and soa.minimum', 'the minimum of soa.minimum and soa ttl',
    'minimum of the soa record ttl and soa.minimum', "minimum of soa.minimum and the soa record's ttl",
    'the smaller of the soa record ttl and soa.minimum', 'the smaller of soa.minimum and the soa record ttl',
    '取两者较小值', '取二者较小值', '两者的最小值', '取soa自身ttl和soa.minimum的较小值',
]);

function knowledge_fold_words(value: string, remove_periods = false): string {
    // Resolve shared normalization lazily: task catalog construction imports this builder.
    const { assessment_casefold, assessment_strip } = require('./assessment_tasks.ts') as typeof import('./assessment_tasks.ts');
    let folded = assessment_strip(assessment_casefold(value));
    if (remove_periods) folded = folded.replace(/\.+$/, '');
    return assessment_strip(folded).replace(/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, ' ');
}

/** Query field order is ignored, but duplicate aliases and additional fields are rejected. */
export function _dns_key_matches(value: unknown, expected: Set<string>): boolean {
    if (!Array.isArray(value) || value.length !== expected.size) return false;
    const aliases: Record<string, string> = {qname:'QNAME', 'query name':'QNAME', qclass:'QCLASS', 'query class':'QCLASS', qtype:'QTYPE', 'query type':'QTYPE'};
    const normalized: string[] = [];
    for (const field of value) {
        if (typeof field !== 'string') return false;
        const identifier = aliases[knowledge_fold_words(field)];
        if (identifier === undefined) return false;
        normalized.push(identifier);
    }
    return new Set(normalized).size === normalized.length && normalized.every(field => expected.has(field));
}

/** Full-string TTL grammar accepts precisely a minimum over both named SOA fields. */
export function _dns_ttl_matches(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const normalized = knowledge_fold_words(value, true);
    if (DNS_TTL_PHRASES.has(normalized)) return true;
    const argument = "(?:soa(?: +|[._])(?:ttl|minimum)|soa(?: record)?'s ttl|soa record ttl|ttl of (?:the )?soa(?: record)?)";
    const match = new RegExp('^(?:min|minimum) *\\( *(' + argument + ') *, *(' + argument + ') *\\)$').exec(normalized);
    if (!match) return false;
    const operands = new Set(match.slice(1).map(field => /^soa(?: +|[._])minimum$/.test(field) ? 'minimum' : 'ttl'));
    return operands.size === 2;
}

type GradeFields = (text: unknown, expected: Record<string, unknown>) => AssessmentGrade;
type ParseAnswer = (text: unknown) => [Record<string, unknown> | null, Record<string, boolean>, string | null];
type ResultFactory = (checks: Record<string, boolean>, instructions: Record<string, boolean>, outcome?: string | null, score?: number | null) => AssessmentGrade;

/** Fresh independent task cards use injected grading callbacks, avoiding runtime import cycles. */
export function build_assessment_knowledge_tasks(grade_fields: GradeFields, parse_answer: ParseAnswer, result_factory: ResultFactory): AssessmentTask[] {
    function grade_dns_negative_cache(text: unknown): AssessmentGrade {
        const [obj, instructions, problem] = parse_answer(text);
        if (problem || !obj) return result_factory({}, instructions, problem, problem === 'abstained' ? 0 : null);
        const result = grade_fields(text, {nxdomain_key:new Set(), nodata_key:new Set(), ttl_rule:DNS_TTL_PHRASES});
        const checks: Record<string, boolean> = Object.fromEntries(Object.entries(DNS_KEY_FIELDS).map(([key, expected]) => [key, _dns_key_matches(obj[key], expected)]));
        checks.ttl_rule = _dns_ttl_matches(obj.ttl_rule);
        result.content_checks = checks;
        result.content_score = Object.values(checks).filter(Boolean).length / Object.keys(checks).length;
        result.outcome = Object.values(result.abstention_checks!).every(Boolean) ? 'abstained' : Object.values(checks).every(Boolean) ? 'correct' : 'incorrect';
        result.asserted_incorrect_checks = Object.fromEntries(Object.entries(checks).map(([key, passed]) => [key, Object.hasOwn(obj, key) && !passed && !result.abstention_checks![key]]));
        return result;
    }
    const graders: Record<string, (text: unknown) => AssessmentGrade> = {
        K04_Genetic_Code: text => grade_fields(text, GENETIC_CODE_EXPECTED),
        K05_DNS_Negative_Cache: grade_dns_negative_cache,
        K06_Treaty_Exceptions: text => grade_fields(text, TREATY_EXCEPTIONS_EXPECTED),
    };
    return KNOWLEDGE_TASK_CARDS.map(card => ({...JSON.parse(JSON.stringify(card)) as Omit<AssessmentTask, 'grade'>, grade: graders[card.id]!} as AssessmentTask));
}

const KNOWLEDGE_TASK_CARDS = [
  {
    "id": "K04_Genetic_Code",
    "title": "Nonstandard mitochondrial codon assignments",
    "prompt": "Without tools or reference lookup, answer specifically for the NCBI Yeast Mitochondrial Code, transl_table=3, not the standard code and not every yeast species. For internal coding positions (not initiation), which amino acid does each RNA codon AUA, CUA, UGA encode in that table? Return one JSON object with fields AUA, CUA, UGA. Use amino-acid full names, three-letter codes or one-letter codes. For a field you do not know, write \"UNKNOWN\".",
    "source": [
      "https://www.ncbi.nlm.nih.gov/Taxonomy/Utils/wprintgc.cgi"
    ],
    "source_sections": [
      "3. The Yeast Mitochondrial Code (transl_table=3)",
      "Differences from the Standard Code"
    ],
    "source_evidence": {
      "AUA": "Met M",
      "CUA": "Thr T",
      "UGA": "Trp W"
    },
    "difficulty_intent": "specialized factual knowledge: explicit exceptions to the standard genetic code",
    "measurement": {
      "necessary_operations": [
        "recall the specified nonstandard code",
        "map three internal codons to amino acids"
      ],
      "confounds": "One table, three correlated checks. NCBI flags species-specific uncertainties, so this question concerns table 3 itself, not universal yeast biology. Initiation is excluded.",
      "status": "source-checked task ready for testing; discrimination and repeated reliability are not yet established"
    },
    "domain": "knowledge",
    "kind": "text",
    "version": "assessment-knowledge-0.1",
    "source_verified_at": "2026-11-10",
    "scoring_rule": "Equal mean of three semantic fields. Format is recorded separately. UNKNOWN is abstention, not a correct fact. Ambiguous/unparseable answers score null. No bank-wide weight is implied."
  },
  {
    "id": "K05_DNS_Negative_Cache",
    "title": "DNS negative-cache keys and TTL",
    "prompt": "Without tools or reference lookup, use the rules stated in RFC 2308 sections 3 and 5, not implementation defaults or later extensions. For NXDOMAIN and NODATA negative answers, which query fields must match for the respective cached answer to be reused? When an authoritative negative response includes its SOA record, how is its initial negative-cache TTL chosen from the SOA record TTL and SOA.MINIMUM? Return one JSON object with nxdomain_key and nodata_key as arrays of query-field identifiers, and ttl_rule as a short expression or phrase. Array order does not matter; do not duplicate fields. For any field you do not know, write \"UNKNOWN\".",
    "source": [
      "https://www.rfc-editor.org/rfc/rfc2308.html"
    ],
    "source_sections": [
      "3 - Negative Answers from Authoritative Servers",
      "5 - Caching Negative Answers"
    ],
    "source_evidence": {
      "nxdomain_key": "<QNAME, QCLASS>",
      "nodata_key": "<QNAME, QTYPE, QCLASS>",
      "ttl_rule": "minimum of the SOA.MINIMUM field and SOA's TTL"
    },
    "difficulty_intent": "specialized protocol facts: distinguish two negative-cache scopes and their TTL rule",
    "measurement": {
      "necessary_operations": [
        "recall RFC cache-key scope",
        "distinguish NXDOMAIN from NODATA",
        "recall the SOA TTL rule"
      ],
      "confounds": "Name-error versus type-error semantics may support inference, so this is not a pure memory isolation test. No deployed resolver behavior or later RFC extensions are claimed.",
      "status": "source-checked task ready for testing; discrimination and repeated reliability are not yet established"
    },
    "domain": "knowledge",
    "kind": "text",
    "version": "assessment-knowledge-0.1",
    "source_verified_at": "2026-11-10",
    "scoring_rule": "Equal mean of three semantic fields. Format is recorded separately. UNKNOWN is abstention, not a correct fact. Ambiguous/unparseable answers score null. No bank-wide weight is implied."
  },
  {
    "id": "K06_Treaty_Exceptions",
    "title": "Treaty validity, performance and a boundary exception",
    "prompt": "Without tools or reference lookup, answer from the text of the 1969 Vienna Convention on the Law of Treaties, not domestic law or a particular dispute. (1) Under Article 53, what is the legal status of a treaty that conflicts with a peremptory norm of general international law at the time of its conclusion? (2) How must treaties in force be performed under Article 26? Give the manner of performance, not the article heading or Latin maxim. (3) Under Article 62(2)(a), may a fundamental change of circumstances be invoked as a ground for terminating or withdrawing from a treaty that establishes a boundary? Return one JSON object: status as a short legal term, performance_principle as a short phrase, and boundary_exception_allowed as a boolean. For a field you do not know, write \"UNKNOWN\".",
    "source": [
      "https://legal.un.org/ilc/texts/instruments/english/conventions/1_1_1969.pdf"
    ],
    "source_sections": [
      "Article 53",
      "Article 26",
      "Article 62(2)(a)"
    ],
    "source_evidence": {
      "status": "A treaty is void if, at the time of its conclusion, it conflicts with a peremptory norm of general international law.",
      "performance_principle": "must be performed by them in good faith",
      "boundary_exception_allowed": "may not be invoked ... if the treaty establishes a boundary"
    },
    "difficulty_intent": "specialized legal-text knowledge: an invalidity rule, a performance requirement and a specific exception",
    "measurement": {
      "necessary_operations": [
        "recall validity under Article 53",
        "recall the performance standard",
        "recall the boundary-treaty exception"
      ],
      "confounds": "Asks the fixed convention text, not legal advice, current case law, party status or complex application. The boundary answer excludes only this ground, not every possible mode of termination.",
      "status": "source-checked task ready for testing; discrimination and repeated reliability are not yet established"
    },
    "domain": "knowledge",
    "kind": "text",
    "version": "assessment-knowledge-0.1",
    "source_verified_at": "2026-11-10",
    "scoring_rule": "Equal mean of three semantic fields. Format is recorded separately. UNKNOWN is abstention, not a correct fact. Ambiguous/unparseable answers score null. No bank-wide weight is implied."
  }
] as const;
