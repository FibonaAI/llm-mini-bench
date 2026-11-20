import { parseAssessmentAnswerJson, assessmentJsonNumberToken } from './assessment_json.ts';

/** Per-task semantic and instruction observations; null means ungradable, never zero. */
export interface AssessmentGrade {
    content_score: number | null;
    content_checks: Record<string, boolean>;
    instruction_checks: Record<string, boolean>;
    outcome: string;
    abstention_checks?: Record<string, boolean>;
    asserted_incorrect_checks?: Record<string, boolean>;
    tool_checks?: Record<string, boolean>;
    tool_calls?: number;
    reason?: string;
}
/** Each sample owns its resettable simulator; model answers are never executable. */
export interface AssessmentSimulator {
    call(name: string, arguments_: unknown): Record<string, unknown>;
    grade(text: unknown): AssessmentGrade;
    history: Array<{name: string; arguments: unknown; result: Record<string, unknown>}>;
}
/** Runnable task card; omit function fields when serializing release snapshots. */
export interface AssessmentTask extends Record<string, unknown> {
    id: string;
    title: string;
    domain: string;
    kind: 'text' | 'tool';
    prompt: string;
    version: string;
    grade: (text: unknown) => AssessmentGrade;
    make_simulator?: () => AssessmentSimulator;
    tools?: Array<Record<string, unknown>>;
    source: string[];
    difficulty_intent: string;
    measurement: { necessary_operations: string[]; confounds: string; status: string };
    scoring_rule: string;
}
/** Historical card revision, not a selectable release bank. */
/** Closed whole-answer abstention vocabulary, case insensitive. */
export const ABSTENTIONS = new Set(['unknown', 'unsure', 'i do not know', 'abstain', '不知道', '不确定']);
/** JSON objects exclude arrays and null. */
export function is_assessment_object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Exact key membership ignores property order and never accepts inherited fields. */
export function assessment_exact_fields(value: Record<string, unknown>, keys: Iterable<string>): boolean {
    const expected = new Set(keys);
    return Object.keys(value).length === expected.size && Object.keys(value).every(key => expected.has(key));
}
/** Preserve JSON integer versus float lexical types (3 is integer; 3.0 and 3e0 are not). */
export function is_assessment_integer(value: unknown, container?: object, key?: string | number): value is number | bigint {
    if (typeof value === 'bigint') return true;
    if (typeof value !== 'number' || !Number.isInteger(value)) return false;
    const token = container && key !== undefined ? assessmentJsonNumberToken(container, key) : undefined;
    return token === undefined || !/[.eE]/.test(token);
}

/** Bound balanced bracket scanning before decoding, including deeply nested input. */
export function _assessment_brace_group_end(text: string, start: number): number {
    const stack: string[] = [];
    let quoted = false, escaped = false;
    for (let index = start; index < text.length; index++) {
        const character = text[index]!;
        if (quoted) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') quoted = false;
            continue;
        }
        if (character === '"') quoted = true;
        else if (character === '{' || character === '[') {
            stack.push(character);
            if (stack.length > 64) throw new Error('Assessment answer nesting exceeds 64 levels');
        } else if (character === '}' || character === ']') {
            if (stack.pop() !== (character === '}' ? '{' : '[')) throw new Error('Assessment answer has mismatched brackets');
            if (!stack.length) return index + 1;
        }
    }
    throw new Error('Assessment answer has an unfinished brace group');
}

function answer_signature(value: unknown, parent?: object, key?: string | number): string {
    if (typeof value === 'bigint') return `integer:${value}`;
    if (typeof value === 'number') {
        const token = parent && key !== undefined ? assessmentJsonNumberToken(parent, key) : undefined;
        if (token && !/[.eE]/.test(token)) return `integer:${BigInt(token)}`;
        return `float:${Object.is(value, -0) ? '-0' : value}`;
    }
    if (Array.isArray(value)) return '[' + value.map((entry, index) => answer_signature(entry, value, index)).join(',') + ']';
    if (is_assessment_object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + answer_signature(value[key], value, key)).join(',') + '}';
    return JSON.stringify(value);
}

/** Skip balanced prose brace groups only; malformed JSON-looking groups poison the entire answer. */
export function parse_assessment_answer(text: unknown): [Record<string, unknown> | null, Record<string, boolean>, string | null] {
    if (typeof text !== 'string') return [null, {json_only: false}, 'ungradable'];
    const objects: Record<string, unknown>[] = [], object_texts: string[] = [];
    let index = 0;
    while (index < text.length) {
        const start = text.indexOf('{', index);
        if (start < 0) break;
        try {
            const end = _assessment_brace_group_end(text, start);
            const group = text.slice(start, end), interior = assessment_strip(group.slice(1, -1));
            if (!interior || /["':\[\]]/.test(interior)) {
                const value = parseAssessmentAnswerJson(group, 64);
                if (!is_assessment_object(value)) throw new Error('Assessment answer object boundary mismatch');
                objects.push(value);
                object_texts.push(group);
            }
            index = end;
        } catch {
            return [null, {json_only: false}, 'ambiguous'];
        }
    }
    if (!objects.length) return [null, {json_only: false}, ABSTENTIONS.has(assessment_strip(text).toLowerCase()) ? 'abstained' : 'ungradable'];
    const canonical = objects.map(value => answer_signature(value));
    if (canonical.some(value => value !== canonical[0])) return [null, {json_only: false}, 'ambiguous'];
    return [objects[0]!, {json_only: objects.length === 1 && assessment_strip(text) === object_texts[0]}, null];
}

/** Semantic checks are separate from output-format observations, including abstention. */
export function assessment_result(checks: Record<string, boolean>, instructions: Record<string, boolean>, outcome: string | null = null, score: number | null = null): AssessmentGrade {
    if (score === null && Object.keys(checks).length) score = Object.values(checks).filter(Boolean).length / Object.keys(checks).length;
    return {content_score: score, content_checks: checks, instruction_checks: instructions, outcome: outcome ?? (score === 1 ? 'correct' : 'incorrect')};
}

/** Exact rational arithmetic for author-written finite oracles and numeric answer matching. */
export class AssessmentFraction {
    readonly numerator: bigint;
    readonly denominator: bigint;
    constructor(numerator: bigint | number, denominator: bigint | number = 1) {
        let n = BigInt(numerator), d = BigInt(denominator);
        if (d === 0n) throw new Error('Assessment rational zero denominator');
        if (d < 0n) { n = -n; d = -d; }
        let a = n < 0n ? -n : n, b = d;
        while (b) { const r = a % b; a = b; b = r; }
        this.numerator = n / a; this.denominator = d / a;
    }
    add(other: AssessmentFraction): AssessmentFraction { return new AssessmentFraction(this.numerator * other.denominator + other.numerator * this.denominator, this.denominator * other.denominator); }
    mul(other: AssessmentFraction): AssessmentFraction { return new AssessmentFraction(this.numerator * other.numerator, this.denominator * other.denominator); }
    div(other: AssessmentFraction): AssessmentFraction { return new AssessmentFraction(this.numerator * other.denominator, this.denominator * other.numerator); }
    equals(other: AssessmentFraction | null): boolean { return other !== null && this.numerator === other.numerator && this.denominator === other.denominator; }
    toString(): string { return this.denominator === 1n ? String(this.numerator) : `${this.numerator}/${this.denominator}`; }
}

// Unicode case-fold expansions frozen from the migration reference runtime.
const ASSESSMENT_CASE_FOLD: Record<string, string> = {"µ":"μ","ß":"ss","ŉ":"ʼn","ſ":"s","ǰ":"ǰ","ͅ":"ι","ΐ":"ΐ","ΰ":"ΰ","ς":"σ","ϐ":"β","ϑ":"θ","ϕ":"φ","ϖ":"π","ϰ":"κ","ϱ":"ρ","ϵ":"ε","և":"եւ","Ꭰ":"Ꭰ","Ꭱ":"Ꭱ","Ꭲ":"Ꭲ","Ꭳ":"Ꭳ","Ꭴ":"Ꭴ","Ꭵ":"Ꭵ","Ꭶ":"Ꭶ","Ꭷ":"Ꭷ","Ꭸ":"Ꭸ","Ꭹ":"Ꭹ","Ꭺ":"Ꭺ","Ꭻ":"Ꭻ","Ꭼ":"Ꭼ","Ꭽ":"Ꭽ","Ꭾ":"Ꭾ","Ꭿ":"Ꭿ","Ꮀ":"Ꮀ","Ꮁ":"Ꮁ","Ꮂ":"Ꮂ","Ꮃ":"Ꮃ","Ꮄ":"Ꮄ","Ꮅ":"Ꮅ","Ꮆ":"Ꮆ","Ꮇ":"Ꮇ","Ꮈ":"Ꮈ","Ꮉ":"Ꮉ","Ꮊ":"Ꮊ","Ꮋ":"Ꮋ","Ꮌ":"Ꮌ","Ꮍ":"Ꮍ","Ꮎ":"Ꮎ","Ꮏ":"Ꮏ","Ꮐ":"Ꮐ","Ꮑ":"Ꮑ","Ꮒ":"Ꮒ","Ꮓ":"Ꮓ","Ꮔ":"Ꮔ","Ꮕ":"Ꮕ","Ꮖ":"Ꮖ","Ꮗ":"Ꮗ","Ꮘ":"Ꮘ","Ꮙ":"Ꮙ","Ꮚ":"Ꮚ","Ꮛ":"Ꮛ","Ꮜ":"Ꮜ","Ꮝ":"Ꮝ","Ꮞ":"Ꮞ","Ꮟ":"Ꮟ","Ꮠ":"Ꮠ","Ꮡ":"Ꮡ","Ꮢ":"Ꮢ","Ꮣ":"Ꮣ","Ꮤ":"Ꮤ","Ꮥ":"Ꮥ","Ꮦ":"Ꮦ","Ꮧ":"Ꮧ","Ꮨ":"Ꮨ","Ꮩ":"Ꮩ","Ꮪ":"Ꮪ","Ꮫ":"Ꮫ","Ꮬ":"Ꮬ","Ꮭ":"Ꮭ","Ꮮ":"Ꮮ","Ꮯ":"Ꮯ","Ꮰ":"Ꮰ","Ꮱ":"Ꮱ","Ꮲ":"Ꮲ","Ꮳ":"Ꮳ","Ꮴ":"Ꮴ","Ꮵ":"Ꮵ","Ꮶ":"Ꮶ","Ꮷ":"Ꮷ","Ꮸ":"Ꮸ","Ꮹ":"Ꮹ","Ꮺ":"Ꮺ","Ꮻ":"Ꮻ","Ꮼ":"Ꮼ","Ꮽ":"Ꮽ","Ꮾ":"Ꮾ","Ꮿ":"Ꮿ","Ᏸ":"Ᏸ","Ᏹ":"Ᏹ","Ᏺ":"Ᏺ","Ᏻ":"Ᏻ","Ᏼ":"Ᏼ","Ᏽ":"Ᏽ","ᏸ":"Ᏸ","ᏹ":"Ᏹ","ᏺ":"Ᏺ","ᏻ":"Ᏻ","ᏼ":"Ᏼ","ᏽ":"Ᏽ","ᲀ":"в","ᲁ":"д","ᲂ":"о","ᲃ":"с","ᲄ":"т","ᲅ":"т","ᲆ":"ъ","ᲇ":"ѣ","ᲈ":"ꙋ","ẖ":"ẖ","ẗ":"ẗ","ẘ":"ẘ","ẙ":"ẙ","ẚ":"aʾ","ẛ":"ṡ","ẞ":"ss","ὐ":"ὐ","ὒ":"ὒ","ὔ":"ὔ","ὖ":"ὖ","ᾀ":"ἀι","ᾁ":"ἁι","ᾂ":"ἂι","ᾃ":"ἃι","ᾄ":"ἄι","ᾅ":"ἅι","ᾆ":"ἆι","ᾇ":"ἇι","ᾈ":"ἀι","ᾉ":"ἁι","ᾊ":"ἂι","ᾋ":"ἃι","ᾌ":"ἄι","ᾍ":"ἅι","ᾎ":"ἆι","ᾏ":"ἇι","ᾐ":"ἠι","ᾑ":"ἡι","ᾒ":"ἢι","ᾓ":"ἣι","ᾔ":"ἤι","ᾕ":"ἥι","ᾖ":"ἦι","ᾗ":"ἧι","ᾘ":"ἠι","ᾙ":"ἡι","ᾚ":"ἢι","ᾛ":"ἣι","ᾜ":"ἤι","ᾝ":"ἥι","ᾞ":"ἦι","ᾟ":"ἧι","ᾠ":"ὠι","ᾡ":"ὡι","ᾢ":"ὢι","ᾣ":"ὣι","ᾤ":"ὤι","ᾥ":"ὥι","ᾦ":"ὦι","ᾧ":"ὧι","ᾨ":"ὠι","ᾩ":"ὡι","ᾪ":"ὢι","ᾫ":"ὣι","ᾬ":"ὤι","ᾭ":"ὥι","ᾮ":"ὦι","ᾯ":"ὧι","ᾲ":"ὰι","ᾳ":"αι","ᾴ":"άι","ᾶ":"ᾶ","ᾷ":"ᾶι","ᾼ":"αι","ι":"ι","ῂ":"ὴι","ῃ":"ηι","ῄ":"ήι","ῆ":"ῆ","ῇ":"ῆι","ῌ":"ηι","ῒ":"ῒ","ΐ":"ΐ","ῖ":"ῖ","ῗ":"ῗ","ῢ":"ῢ","ΰ":"ΰ","ῤ":"ῤ","ῦ":"ῦ","ῧ":"ῧ","ῲ":"ὼι","ῳ":"ωι","ῴ":"ώι","ῶ":"ῶ","ῷ":"ῶι","ῼ":"ωι","ꭰ":"Ꭰ","ꭱ":"Ꭱ","ꭲ":"Ꭲ","ꭳ":"Ꭳ","ꭴ":"Ꭴ","ꭵ":"Ꭵ","ꭶ":"Ꭶ","ꭷ":"Ꭷ","ꭸ":"Ꭸ","ꭹ":"Ꭹ","ꭺ":"Ꭺ","ꭻ":"Ꭻ","ꭼ":"Ꭼ","ꭽ":"Ꭽ","ꭾ":"Ꭾ","ꭿ":"Ꭿ","ꮀ":"Ꮀ","ꮁ":"Ꮁ","ꮂ":"Ꮂ","ꮃ":"Ꮃ","ꮄ":"Ꮄ","ꮅ":"Ꮅ","ꮆ":"Ꮆ","ꮇ":"Ꮇ","ꮈ":"Ꮈ","ꮉ":"Ꮉ","ꮊ":"Ꮊ","ꮋ":"Ꮋ","ꮌ":"Ꮌ","ꮍ":"Ꮍ","ꮎ":"Ꮎ","ꮏ":"Ꮏ","ꮐ":"Ꮐ","ꮑ":"Ꮑ","ꮒ":"Ꮒ","ꮓ":"Ꮓ","ꮔ":"Ꮔ","ꮕ":"Ꮕ","ꮖ":"Ꮖ","ꮗ":"Ꮗ","ꮘ":"Ꮘ","ꮙ":"Ꮙ","ꮚ":"Ꮚ","ꮛ":"Ꮛ","ꮜ":"Ꮜ","ꮝ":"Ꮝ","ꮞ":"Ꮞ","ꮟ":"Ꮟ","ꮠ":"Ꮠ","ꮡ":"Ꮡ","ꮢ":"Ꮢ","ꮣ":"Ꮣ","ꮤ":"Ꮤ","ꮥ":"Ꮥ","ꮦ":"Ꮦ","ꮧ":"Ꮧ","ꮨ":"Ꮨ","ꮩ":"Ꮩ","ꮪ":"Ꮪ","ꮫ":"Ꮫ","ꮬ":"Ꮬ","ꮭ":"Ꮭ","ꮮ":"Ꮮ","ꮯ":"Ꮯ","ꮰ":"Ꮰ","ꮱ":"Ꮱ","ꮲ":"Ꮲ","ꮳ":"Ꮳ","ꮴ":"Ꮴ","ꮵ":"Ꮵ","ꮶ":"Ꮶ","ꮷ":"Ꮷ","ꮸ":"Ꮸ","ꮹ":"Ꮹ","ꮺ":"Ꮺ","ꮻ":"Ꮻ","ꮼ":"Ꮼ","ꮽ":"Ꮽ","ꮾ":"Ꮾ","ꮿ":"Ꮿ","ﬀ":"ff","ﬁ":"fi","ﬂ":"fl","ﬃ":"ffi","ﬄ":"ffl","ﬅ":"st","ﬆ":"st","ﬓ":"մն","ﬔ":"մե","ﬕ":"մի","ﬖ":"վն","ﬗ":"մխ"};

/** Unicode full case folding, including expansions that lowercase alone cannot represent. */
export function assessment_casefold(value: string): string {
    return Array.from(value, character => ASSESSMENT_CASE_FOLD[character] ?? character.toLowerCase()).join('');
}
/** Python-compatible Unicode whitespace trimming; a BOM is not whitespace. */
export function assessment_strip(value: string): string {
    return value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, '');
}

// Unicode canonical combining classes frozen from the migration reference runtime.
// Category M alone is not equivalent: spacing marks with combining class zero must remain.
const ASSESSMENT_COMBINING_MARKS = /[\u{300}-\u{34e}\u{350}-\u{36f}\u{483}-\u{487}\u{591}-\u{5bd}\u{5bf}\u{5c1}-\u{5c2}\u{5c4}-\u{5c5}\u{5c7}\u{610}-\u{61a}\u{64b}-\u{65f}\u{670}\u{6d6}-\u{6dc}\u{6df}-\u{6e4}\u{6e7}-\u{6e8}\u{6ea}-\u{6ed}\u{711}\u{730}-\u{74a}\u{7eb}-\u{7f3}\u{7fd}\u{816}-\u{819}\u{81b}-\u{823}\u{825}-\u{827}\u{829}-\u{82d}\u{859}-\u{85b}\u{897}-\u{89f}\u{8ca}-\u{8e1}\u{8e3}-\u{8ff}\u{93c}\u{94d}\u{951}-\u{954}\u{9bc}\u{9cd}\u{9fe}\u{a3c}\u{a4d}\u{abc}\u{acd}\u{b3c}\u{b4d}\u{bcd}\u{c3c}\u{c4d}\u{c55}-\u{c56}\u{cbc}\u{ccd}\u{d3b}-\u{d3c}\u{d4d}\u{dca}\u{e38}-\u{e3a}\u{e48}-\u{e4b}\u{eb8}-\u{eba}\u{ec8}-\u{ecb}\u{f18}-\u{f19}\u{f35}\u{f37}\u{f39}\u{f71}-\u{f72}\u{f74}\u{f7a}-\u{f7d}\u{f80}\u{f82}-\u{f84}\u{f86}-\u{f87}\u{fc6}\u{1037}\u{1039}-\u{103a}\u{108d}\u{135d}-\u{135f}\u{1714}-\u{1715}\u{1734}\u{17d2}\u{17dd}\u{18a9}\u{1939}-\u{193b}\u{1a17}-\u{1a18}\u{1a60}\u{1a75}-\u{1a7c}\u{1a7f}\u{1ab0}-\u{1abd}\u{1abf}-\u{1add}\u{1ae0}-\u{1aeb}\u{1b34}\u{1b44}\u{1b6b}-\u{1b73}\u{1baa}-\u{1bab}\u{1be6}\u{1bf2}-\u{1bf3}\u{1c37}\u{1cd0}-\u{1cd2}\u{1cd4}-\u{1ce0}\u{1ce2}-\u{1ce8}\u{1ced}\u{1cf4}\u{1cf8}-\u{1cf9}\u{1dc0}-\u{1dff}\u{20d0}-\u{20dc}\u{20e1}\u{20e5}-\u{20f0}\u{2cef}-\u{2cf1}\u{2d7f}\u{2de0}-\u{2dff}\u{302a}-\u{302f}\u{3099}-\u{309a}\u{a66f}\u{a674}-\u{a67d}\u{a69e}-\u{a69f}\u{a6f0}-\u{a6f1}\u{a806}\u{a82c}\u{a8c4}\u{a8e0}-\u{a8f1}\u{a92b}-\u{a92d}\u{a953}\u{a9b3}\u{a9c0}\u{aab0}\u{aab2}-\u{aab4}\u{aab7}-\u{aab8}\u{aabe}-\u{aabf}\u{aac1}\u{aaf6}\u{abed}\u{fb1e}\u{fe20}-\u{fe2f}\u{101fd}\u{102e0}\u{10376}-\u{1037a}\u{10a0d}\u{10a0f}\u{10a38}-\u{10a3a}\u{10a3f}\u{10ae5}-\u{10ae6}\u{10d24}-\u{10d27}\u{10d69}-\u{10d6d}\u{10eab}-\u{10eac}\u{10efa}-\u{10efb}\u{10efd}-\u{10eff}\u{10f46}-\u{10f50}\u{10f82}-\u{10f85}\u{11046}\u{11070}\u{1107f}\u{110b9}-\u{110ba}\u{11100}-\u{11102}\u{11133}-\u{11134}\u{11173}\u{111c0}\u{111ca}\u{11235}-\u{11236}\u{112e9}-\u{112ea}\u{1133b}-\u{1133c}\u{1134d}\u{11366}-\u{1136c}\u{11370}-\u{11374}\u{113ce}-\u{113d0}\u{11442}\u{11446}\u{1145e}\u{114c2}-\u{114c3}\u{115bf}-\u{115c0}\u{1163f}\u{116b6}-\u{116b7}\u{1172b}\u{11839}-\u{1183a}\u{1193d}-\u{1193e}\u{11943}\u{119e0}\u{11a34}\u{11a47}\u{11a99}\u{11c3f}\u{11d42}\u{11d44}-\u{11d45}\u{11d97}\u{11f41}-\u{11f42}\u{1612f}\u{16af0}-\u{16af4}\u{16b30}-\u{16b36}\u{16ff0}-\u{16ff1}\u{1bc9e}\u{1d165}-\u{1d169}\u{1d16d}-\u{1d172}\u{1d17b}-\u{1d182}\u{1d185}-\u{1d18b}\u{1d1aa}-\u{1d1ad}\u{1d242}-\u{1d244}\u{1e000}-\u{1e006}\u{1e008}-\u{1e018}\u{1e01b}-\u{1e021}\u{1e023}-\u{1e024}\u{1e026}-\u{1e02a}\u{1e08f}\u{1e130}-\u{1e136}\u{1e2ae}\u{1e2ec}-\u{1e2ef}\u{1e4ec}-\u{1e4ef}\u{1e5ee}-\u{1e5ef}\u{1e6e3}\u{1e6e6}\u{1e6ee}-\u{1e6ef}\u{1e6f5}\u{1e8d0}-\u{1e8d6}\u{1e944}-\u{1e94a}]/gu;

/** Frozen alias normalization: Unicode compatibility decomposition, case folding, combining removal. */
export function _normalized_name(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    return assessment_strip(assessment_casefold(value).normalize('NFKD').replace(ASSESSMENT_COMBINING_MARKS, '')).replace(/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000_-]+/g, ' ').replace(/\.+$/, '');
}

function decimal_digits(value: string): string {
    const zeros = [0x30,0x660,0x6f0,0x7c0,0x966,0x9e6,0xa66,0xae6,0xb66,0xbe6,0xc66,0xce6,0xd66,0xde6,0xe50,0xed0,0xf20,0x1040,0x1090,0x17e0,0x1810,0x1946,0x19d0,0x1a80,0x1a90,0x1b50,0x1bb0,0x1c40,0x1c50,0xa620,0xa8d0,0xa900,0xa9d0,0xa9f0,0xaa50,0xabf0,0xff10,0x104a0,0x10d30,0x10d40,0x11066,0x110f0,0x11136,0x111d0,0x112f0,0x11450,0x114d0,0x11650,0x116c0,0x116d0,0x116da,0x11730,0x118e0,0x11950,0x11bf0,0x11c50,0x11d50,0x11da0,0x11de0,0x11f50,0x16130,0x16a60,0x16ac0,0x16b50,0x16d70,0x1ccf0,0x1d7ce,0x1d7d8,0x1d7e2,0x1d7ec,0x1d7f6,0x1e140,0x1e2f0,0x1e4f0,0x1e5f1,0x1e950,0x1fbf0];
    return Array.from(value, ch => { const cp = ch.codePointAt(0)!; const zero = zeros.find(z => z <= cp && cp < z + 10); return zero === undefined ? ch : String(cp - zero); }).join('');
}

/** Parse Python Fraction-compatible exact decimal/fraction strings without eval or float rounding. */
export function _rational(value: unknown, numberToken?: string): AssessmentFraction | null {
    if (typeof value === 'bigint') return new AssessmentFraction(value);
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    let text = assessment_strip(decimal_digits((numberToken && !/[.eE]/.test(numberToken) ? numberToken : String(value)).replaceAll(' ', '')));
    if (text.includes('_')) {
        if (/(?<!\d)_(?!$)|_(?!\d)/.test(text)) return null;
        text = text.replaceAll('_', '');
    }
    try {
        const fraction = /^([+-]?\d+)\/(\d+)$/.exec(text);
        if (fraction) return new AssessmentFraction(BigInt(fraction[1]!), BigInt(fraction[2]!));
        const decimal = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
        if (!decimal) return null;
        const decimals = decimal[3] ?? decimal[4] ?? '';
        const exponent = Number(decimal[5] ?? 0) - decimals.length;
        if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100000) return null;
        const coefficient = BigInt((decimal[1] === '-' ? '-' : '') + (decimal[2] ?? '0') + decimals);
        return exponent >= 0 ? new AssessmentFraction(coefficient * 10n ** BigInt(exponent)) : new AssessmentFraction(coefficient, 10n ** BigInt(-exponent));
    } catch { return null; }
}

/** Match semantic values using exact fractions and closed, whole-field aliases; booleans are not numbers. */
export function _matches_answer(value: unknown, expected: unknown, numberToken?: string): boolean {
    if (expected instanceof AssessmentFraction) return expected.equals(_rational(value, numberToken));
    if (expected instanceof Set) return [...expected].some(alias => _normalized_name(alias) === _normalized_name(value)) && typeof value === 'string';
    if (typeof expected === 'number' && Number.isInteger(expected)) return new AssessmentFraction(expected).equals(_rational(value, numberToken));
    if (Array.isArray(expected)) return Array.isArray(value) && value.length === expected.length && expected.every((answer, key) => _matches_answer(value[key], answer, assessmentJsonNumberToken(value, key)));
    if (is_assessment_object(expected)) return is_assessment_object(value) && assessment_exact_fields(value, Object.keys(expected)) && Object.entries(expected).every(([key, answer]) => _matches_answer(value[key], answer, assessmentJsonNumberToken(value, key)));
    return typeof value === typeof expected && value === expected;
}

/** Score named semantic atoms; exact fractions and frozen aliases are accepted without substring matching. */
export function grade_assessment_fields(text: unknown, expected: Record<string, unknown>): AssessmentGrade {
    const [obj, instructions, problem] = parse_assessment_answer(text);
    if (problem || !obj) return assessment_result({}, instructions, problem, problem === 'abstained' ? 0 : null);
    instructions.exact_fields = assessment_exact_fields(obj, Object.keys(expected));
    const abstained: Record<string, boolean> = {}, checks: Record<string, boolean> = {}, incorrect: Record<string, boolean> = {};
    for (const [key, answer] of Object.entries(expected)) {
        abstained[key] = typeof obj[key] === 'string' && ABSTENTIONS.has(assessment_strip(obj[key] as string).toLowerCase());
        checks[key] = Object.hasOwn(obj, key) && _matches_answer(obj[key], answer, assessmentJsonNumberToken(obj, key));
        incorrect[key] = Object.hasOwn(obj, key) && !checks[key] && !abstained[key];
    }
    return {...assessment_result(checks, instructions, Object.values(abstained).every(Boolean) ? 'abstained' : null), abstention_checks: abstained, asserted_incorrect_checks: incorrect};
}
