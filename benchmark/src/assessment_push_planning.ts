import type { AssessmentGrade, AssessmentSimulator, AssessmentTask } from './assessment_tasks.ts';

/** Fully observable, fixed-data push-only board planning without action budgets. */
export const ASSESSMENT_PUSH_PLANNING_TASK_FORMAT = 'assessment-push-planning-v1';
type PushObject = Record<string, unknown>;
/** ASCII board with walls, floor, targets, one player and equally many boxes and targets. */
export type AssessmentPushPlanningConfig = { rows: string[] };
type PushDirection = 'up' | 'down' | 'left' | 'right';
const directions: Record<PushDirection, readonly [number, number]> = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
const object = (value: unknown): value is PushObject => value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactFields = (value: PushObject, fields: string[]) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
function requirePushPlanning(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error('Assessment push planning task ' + reason); }

function pushPlanningConfig(value: unknown): AssessmentPushPlanningConfig {
    requirePushPlanning(object(value) && exactFields(value, ['rows']) && Array.isArray(value.rows), 'requires exactly a rows array');
    const rows = Array.from(value.rows);
    requirePushPlanning(rows.length >= 3 && rows.length <= 32 && rows.every(row => typeof row === 'string' && row.length >= 3 && row.length <= 32 && /^[# .@$+*]+$/.test(row)), 'rows must use supported ASCII cells within a 3 to 32 by 3 to 32 board');
    const board = rows as string[], width = board[0]!.length;
    requirePushPlanning(board.every(row => row.length === width), 'rows must be rectangular');
    requirePushPlanning([...board[0]!, ...board.at(-1)!].every(cell => cell === '#') && board.every(row => row[0] === '#' && row.at(-1) === '#'), 'border cells must be walls');
    const cells = board.join('');
    const players = [...cells].filter(cell => cell === '@' || cell === '+').length;
    const boxes = [...cells].filter(cell => cell === '$' || cell === '*').length;
    const targets = [...cells].filter(cell => cell === '.' || cell === '+' || cell === '*').length;
    requirePushPlanning(players === 1, 'requires exactly one player');
    requirePushPlanning(boxes > 0 && boxes === targets, 'requires equally many positive boxes and targets');
    return { rows: [...board] };
}

/** Strict, repeatable inspection and one-step cardinal movement schemas. */
export function assessment_push_planning_tools(): PushObject[] {
    return [
        { type: 'function', name: 'inspect_board', description: 'Inspect the complete current board, successful move and push counts, and goal status. Free and repeatable.', parameters: {
            type: 'object', properties: {}, required: [], additionalProperties: false }, strict: true },
        { type: 'function', name: 'move_player', description: 'Move one cardinal step, pushing exactly one adjacent box if the next cell is free. No pulling, jumping, swapping, undo or reset. Rejections change no board or counters. Handling stops at the goal.', parameters: {
            type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] } }, required: ['direction'], additionalProperties: false }, strict: true }
    ];
}

/** In-memory board simulator; only fixed movement rules run, never submitted code. */
export class PushPlanningAssessmentSimulator implements AssessmentSimulator {
    private readonly width: number;
    private readonly height: number;
    private readonly walls = new Set<number>();
    private readonly targets = new Set<number>();
    private readonly boxes = new Set<number>();
    private player = 0;
    private moves = 0;
    private pushes = 0;
    private invalidAttempts = 0;
    private inspections = 0;
    history: AssessmentSimulator['history'] = [];

    constructor(config: unknown) {
        const { rows } = pushPlanningConfig(config);
        this.width = rows[0]!.length;
        this.height = rows.length;
        for (let row = 0; row < this.height; row++) for (let column = 0; column < this.width; column++) {
            const cell = rows[row]![column]!, position = row * this.width + column;
            if (cell === '#') this.walls.add(position);
            if ('.+*'.includes(cell)) this.targets.add(position);
            if ('$*'.includes(cell)) this.boxes.add(position);
            if ('@+'.includes(cell)) this.player = position;
        }
    }

    private goal(): boolean { return [...this.boxes].every(position => this.targets.has(position)); }

    private snapshot(): PushObject {
        const rows = Array.from({ length: this.height }, (_, row) => Array.from({ length: this.width }, (_, column) => {
            const position = row * this.width + column;
            if (this.walls.has(position)) return '#';
            if (position === this.player) return this.targets.has(position) ? '+' : '@';
            if (this.boxes.has(position)) return this.targets.has(position) ? '*' : '$';
            return this.targets.has(position) ? '.' : ' ';
        }).join(''));
        return { rows, moves: this.moves, pushes: this.pushes, status: this.goal() ? 'complete' : 'incomplete' };
    }

    call(name: string, args: unknown): PushObject {
        let error: string | null = null;
        if (!object(args)) error = 'arguments must be an object';
        else if (name === 'inspect_board' && exactFields(args, [])) this.inspections++;
        else if (!(name === 'move_player' && exactFields(args, ['direction']))) error = 'unknown tool or invalid argument fields';
        else if (typeof args.direction !== 'string' || !Object.hasOwn(directions, args.direction)) error = 'unknown direction';
        else if (this.goal()) error = 'board already complete';
        else {
            const [dr, dc] = directions[args.direction as PushDirection];
            const next = this.player + dr * this.width + dc;
            const beyond = next + dr * this.width + dc;
            if (this.walls.has(next)) error = 'movement blocked by wall';
            else if (this.boxes.has(next) && (this.walls.has(beyond) || this.boxes.has(beyond))) error = 'box push blocked';
            else {
                if (this.boxes.has(next)) { this.boxes.delete(next); this.boxes.add(beyond); this.pushes++; }
                this.player = next;
                this.moves++;
            }
        }
        if (error) this.invalidAttempts++;
        const result = { ok: error === null, ...(error ? { error } : {}), ...this.snapshot() };
        let recordedArguments: unknown;
        try { recordedArguments = structuredClone(args); } catch { recordedArguments = null; }
        this.history.push({ name, arguments: recordedArguments, result: structuredClone(result) });
        return structuredClone(result);
    }

    grade(text: unknown): AssessmentGrade {
        const { assessment_result, parse_assessment_answer, assessment_exact_fields } = require('./assessment_tasks.ts') as typeof import('./assessment_tasks.ts');
        const [answer, instructions, problem] = parse_assessment_answer(text);
        const goal = this.goal();
        instructions.exact_fields = problem === null && answer !== null && assessment_exact_fields(answer, ['status', 'moves', 'pushes']);
        const truthful = instructions.exact_fields && answer !== null && answer.status === (goal ? 'complete' : 'incomplete')
            && answer.moves === this.moves && answer.pushes === this.pushes;
        const result = assessment_result({ goal_reached: goal }, instructions, null, Number(goal));
        result.tool_checks = { goal_reached: goal, used_tools: this.history.length > 0, observed_board: this.inspections > 0,
            no_invalid_attempts: this.invalidAttempts === 0, final_report_truthful: truthful };
        result.tool_calls = this.history.length;
        return result;
    }
}

/** Attach fresh schemas and isolated simulator instances to a serializable tool task. */
export function configure_assessment_push_planning_task(card: AssessmentTask, config: unknown): AssessmentTask {
    const validated = pushPlanningConfig(config);
    card.kind = 'tool';
    card.tools = assessment_push_planning_tools();
    card.make_simulator = () => new PushPlanningAssessmentSimulator(validated);
    card.grade = () => ({ content_score: null, content_checks: {}, instruction_checks: {}, tool_checks: {}, outcome: 'ungradable', reason: 'Use the same push planning simulator instance that received real tool calls.' });
    return card;
}
