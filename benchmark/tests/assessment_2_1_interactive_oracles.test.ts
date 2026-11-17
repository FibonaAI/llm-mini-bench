import { describe, expect, test } from 'bun:test';
import { load_assessment_bank } from '../src/assessment_bank.ts';
import { BlackboxAssessmentSimulator } from '../src/assessment_blackbox.ts';
const bank = load_assessment_bank('2.1'),
    tasks = new Map(bank.tasks.map(task => [task.id, task]));
const inputs = [
    {
        bank_id: 'T2_Causal_Pathway_Probes',
        cases: [
            { case_id: 'EXP_1', input: { u: 0, s: 4, op_x: 'none', vx: 0, op_m: 'none', vm: 0 } },
            { case_id: 'EXP_2', input: { u: 0, s: 3, op_x: 'shift', vx: 2, op_m: 'none', vm: 0 } },
            { case_id: 'EXP_3', input: { u: 1, s: 1, op_x: 'shift', vx: 1, op_m: 'none', vm: 0 } },
            { case_id: 'EXP_4', input: { u: 0, s: 6, op_x: 'none', vx: 0, op_m: 'none', vm: 0 } },
            { case_id: 'EXP_5', input: { u: 0, s: 4, op_x: 'none', vx: 0, op_m: 'do', vm: 2 } },
            { case_id: 'EXP_6', input: { u: 1, s: 4, op_x: 'shift', vx: -2, op_m: 'none', vm: 0 } },
            { case_id: 'EXP_7', input: { u: 1, s: 1, op_x: 'shift', vx: 1, op_m: 'do', vm: 1 } },
            { case_id: 'EXP_8', input: { u: 1, s: 5, op_x: 'do', vx: 2, op_m: 'do', vm: 3 } }
        ]
    },
    {
        bank_id: 'T2_Scoped_Exception_Probes',
        cases: [
            {
                case_id: 'CODE_1',
                input: { init_x: 10, try_add: 0, guard_cap: 12, throws: false, catch_add: 0, finally_add: 0, weight_cap: 2 }
            },
            {
                case_id: 'CODE_2',
                input: { init_x: 5, try_add: 3, guard_cap: 10, throws: false, catch_add: 0, finally_add: 0, weight_cap: 1 }
            },
            {
                case_id: 'CODE_3',
                input: { init_x: 5, try_add: 6, guard_cap: 8, throws: false, catch_add: 0, finally_add: 0, weight_cap: 1 }
            },
            {
                case_id: 'CODE_4',
                input: { init_x: 10, try_add: 3, guard_cap: 15, throws: true, catch_add: 2, finally_add: 5, weight_cap: 0 }
            },
            {
                case_id: 'CODE_5',
                input: { init_x: 10, try_add: 3, guard_cap: 15, throws: true, catch_add: 2, finally_add: 0, weight_cap: 0 }
            },
            {
                case_id: 'CODE_6',
                input: { init_x: 10, try_add: 3, guard_cap: 15, throws: false, catch_add: 2, finally_add: 4, weight_cap: 0 }
            },
            {
                case_id: 'CODE_7',
                input: { init_x: 10, try_add: 4, guard_cap: 15, throws: true, catch_add: 1, finally_add: 4, weight_cap: 0 }
            },
            {
                case_id: 'CODE_8',
                input: { init_x: 10, try_add: 0, guard_cap: 10, throws: true, catch_add: 2, finally_add: 0, weight_cap: 1 }
            }
        ]
    },
    {
        bank_id: 'T2_Aging_Scheduler_Probes',
        cases: [
            {
                case_id: 'SCHED_1',
                input: {
                    jobs: [
                        { job_id: 'J1', arrival: 0, service: 2, base_prio: 10, heavy_affinity: false },
                        { job_id: 'J2', arrival: 1, service: 2, base_prio: 8, heavy_affinity: false },
                        { job_id: 'J3', arrival: 2, service: 2, base_prio: 5, heavy_affinity: false },
                        { job_id: 'J4', arrival: 3, service: 1, base_prio: 1, heavy_affinity: false }
                    ]
                }
            },
            {
                case_id: 'SCHED_2',
                input: {
                    jobs: [
                        { job_id: 'J1', arrival: 0, service: 3, base_prio: 10, heavy_affinity: false },
                        { job_id: 'J2', arrival: 1, service: 2, base_prio: 4, heavy_affinity: false },
                        { job_id: 'J3', arrival: 3, service: 1, base_prio: 7, heavy_affinity: false }
                    ]
                }
            },
            {
                case_id: 'SCHED_3',
                input: {
                    jobs: [
                        { job_id: 'J1', arrival: 0, service: 2, base_prio: 20, heavy_affinity: false },
                        { job_id: 'J2', arrival: 2, service: 2, base_prio: 18, heavy_affinity: false },
                        { job_id: 'J3', arrival: 2, service: 1, base_prio: 7, heavy_affinity: false },
                        { job_id: 'J4', arrival: 0, service: 1, base_prio: 4, heavy_affinity: false },
                        { job_id: 'J5', arrival: 4, service: 1, base_prio: 6, heavy_affinity: false }
                    ]
                }
            },
            {
                case_id: 'SCHED_4',
                input: {
                    jobs: [
                        { job_id: 'J1', arrival: 0, service: 2, base_prio: 10, heavy_affinity: false },
                        { job_id: 'J2', arrival: 2, service: 3, base_prio: 5, heavy_affinity: false },
                        { job_id: 'J3', arrival: 2, service: 1, base_prio: 5, heavy_affinity: false }
                    ]
                }
            },
            {
                case_id: 'SCHED_5',
                input: {
                    jobs: [
                        { job_id: 'J1', arrival: 0, service: 4, base_prio: 10, heavy_affinity: false },
                        { job_id: 'J2', arrival: 4, service: 1, base_prio: 6, heavy_affinity: true },
                        { job_id: 'J3', arrival: 4, service: 2, base_prio: 5, heavy_affinity: false }
                    ]
                }
            },
            {
                case_id: 'SCHED_6',
                input: {
                    jobs: [
                        { job_id: 'J1', arrival: 0, service: 2, base_prio: 10, heavy_affinity: false },
                        { job_id: 'J2', arrival: 0, service: 1, base_prio: 5, heavy_affinity: false },
                        { job_id: 'J3', arrival: 2, service: 1, base_prio: 6, heavy_affinity: false }
                    ]
                }
            },
            {
                case_id: 'SCHED_7',
                input: {
                    jobs: [
                        { job_id: 'J1', arrival: 0, service: 2, base_prio: 20, heavy_affinity: false },
                        { job_id: 'J2', arrival: 2, service: 2, base_prio: 15, heavy_affinity: false },
                        { job_id: 'J3', arrival: 0, service: 1, base_prio: 4, heavy_affinity: false },
                        { job_id: 'J4', arrival: 4, service: 1, base_prio: 6, heavy_affinity: false }
                    ]
                }
            },
            {
                case_id: 'SCHED_8',
                input: {
                    jobs: [
                        { job_id: 'J1', arrival: 0, service: 4, base_prio: 10, heavy_affinity: false },
                        { job_id: 'J2', arrival: 4, service: 3, base_prio: 7, heavy_affinity: true },
                        { job_id: 'J3', arrival: 4, service: 1, base_prio: 5, heavy_affinity: false }
                    ]
                }
            },
            {
                case_id: 'SCHED_9',
                input: {
                    jobs: [
                        { job_id: 'J1', arrival: 0, service: 4, base_prio: 12, heavy_affinity: false },
                        { job_id: 'J2', arrival: 4, service: 2, base_prio: 9, heavy_affinity: true },
                        { job_id: 'J3', arrival: 4, service: 1, base_prio: 6, heavy_affinity: false }
                    ]
                }
            }
        ]
    }
] as any[];

function causalOutputs(cases: any[], n: number) {
    const outputs: Record<string, number> = {};
    for (const { case_id, input: i } of cases) {
        let X: number;
        if (i.op_x === 'none') X = i.s + 2 * i.u;
        else if (i.op_x === 'do') X = i.vx;
        else if ([1, 2, 7, 8].includes(n)) X = i.s + 2 * i.u + i.vx;
        else if ([3, 4, 9, 10].includes(n)) X = i.s + i.vx;
        else X = i.s + 2 * i.u + (1 + i.u) * i.vx;
        let M0 = Math.max(0, X - 2);
        if (n % 2 === 0) M0 = Math.min(3, M0);
        const M = i.op_m === 'do' ? i.vm : M0,
            direct = n >= 7 && i.op_m === 'do' ? Math.min(X, 2) : X;
        outputs[case_id] = 2 * M + direct + 3 * i.u;
    }
    return outputs;
}
function codeOutputs(cases: any[], n: number) {
    const outputs: Record<string, number> = {};
    for (const { case_id, input: i } of cases) {
        const x0 = i.init_x,
            xt = x0 + i.try_add,
            captured = n <= 3 ? x0 : n <= 6 ? Math.min(xt, i.guard_cap) : xt;
        const rollback = n % 3 === 2 || n % 3 === 0,
            early = n % 3 === 0;
        const after = i.throws ? (rollback ? x0 : xt) + i.catch_add : xt;
        outputs[case_id] = i.weight_cap * captured + after + (early ? i.finally_add : 0);
    }
    return outputs;
}
function schedulerOutputs(cases: any[], n: number) {
    const outputs: Record<string, string> = {},
        fcfs = Math.floor((n - 1) / 2) % 2 === 0;
    for (const { case_id, input } of cases) {
        const jobs = input.jobs.map((job: any, index: number) => ({ ...job, index }));
        let time = 0,
            previousHeavy = false;
        const sequence: string[] = [];
        while (jobs.length) {
            let ready = jobs.filter((job: any) => job.arrival <= time);
            if (!ready.length) {
                time = Math.min(...jobs.map((job: any) => job.arrival));
                previousHeavy = false;
                ready = jobs.filter((job: any) => job.arrival <= time);
            }
            const priority = (job: any) => {
                const wait = time - job.arrival,
                    age = n <= 4 ? 0 : n <= 8 ? wait : wait >= 3 ? 2 * (wait - 2) : 0;
                return job.base_prio + age + (n % 2 === 0 && previousHeavy && job.heavy_affinity ? -2 : 0);
            };
            const best = Math.max(...ready.map(priority)),
                tied = ready.filter((job: any) => priority(job) === best);
            tied.sort((a: any, b: any) => (fcfs ? a.arrival - b.arrival || a.index - b.index : a.service - b.service || a.index - b.index));
            const chosen = tied[0];
            sequence.push(chosen.job_id);
            time += chosen.service;
            previousHeavy = chosen.service >= 4;
            jobs.splice(jobs.indexOf(chosen), 1);
        }
        outputs[case_id] = sequence.join('->');
    }
    return outputs;
}
function tariffSupersessionOracle() {
    const cutoff = '2026-06-30';
    const shipments = [
        { id: 'S1', commodity: 'CO', tons: 45, arrival_date: '2026-05-10', cert: 'EC-10' },
        { id: 'S2', commodity: 'CO', tons: 30, arrival_date: '2026-05-22', cert: 'EC-10' },
        { id: 'S3', commodity: 'LI', tons: 70, arrival_date: '2026-06-02', cert: 'EC-20' },
        { id: 'S4', commodity: 'NI', tons: 50, arrival_date: '2026-06-15', cert: 'EC-30' }
    ] as const;

    const docs = [
        {
            doc_id: 'D1',
            source: 'STATUTE',
            issued_date: '2025-11-01',
            enacted: true,
            series: 'ACT-2025-CM',
            base_rate: { CO: 120, LI: 90, NI: 60 },
            carbon_fee: { CO: 20, LI: 15, NI: 10 },
            default_quota: { CO: 30, LI: 50, NI: 60 },
            over_quota_multiplier: 2,
            delegation: { source: 'CUSTOMS_RULING', series: 'CR-SUBPART-B', min_date: '2026-01-01' }
        },
        { doc_id: 'D2', source: 'MINISTRY_CIRCULAR', issued_date: '2026-01-15', enacted: true, series: 'MC-2026-04' },
        {
            doc_id: 'D3',
            source: 'CUSTOMS_RULING',
            issued_date: '2026-02-20',
            enacted: true,
            series: 'CR-SUBPART-B',
            quotas: { CO: 50, LI: 80, NI: 100 },
            certs: {
                'EC-10': { discount: 30, waives_carbon: true },
                'EC-20': { discount: 20, waives_carbon: true },
                'EC-30': { discount: 15, waives_carbon: false }
            }
        },
        { doc_id: 'D4', source: 'PORT_NOTICE', issued_date: '2026-04-10', enacted: true, series: 'PN-2026-18' },
        {
            doc_id: 'D5',
            source: 'CUSTOMS_RULING',
            issued_date: '2026-05-18',
            enacted: true,
            series: 'CR-SUBPART-B',
            quotas: { CO: 40, LI: 60 },
            cert_amendments: {
                'EC-10': { mode: 'REVOKED' as const, from: '2026-05-15', discount: 0, waives_carbon: false },
                'EC-30': { mode: 'AMENDED_REDUCED' as const, from: '2026-05-01', discount: 5, waives_carbon: false }
            },
            attempted_statutory_overrides: ['D5:SEC_4_LI_BASE_RATE']
        },
        { doc_id: 'D6', source: 'CUSTOMS_RULING', issued_date: '2026-03-12', enacted: true, series: 'CR-SUBPART-C' },
        { doc_id: 'D7', source: 'STATUTE', issued_date: '2026-07-05', enacted: true, series: 'ACT-2026-H2' }
    ];

    const inWindow = docs.filter(d => d.enacted && d.issued_date <= cutoff);
    const statute = inWindow
        .filter((d): d is Extract<(typeof docs)[number], { delegation: object }> => d.source === 'STATUTE' && d.delegation !== undefined)
        .sort((a, b) => a.issued_date.localeCompare(b.issued_date))
        .at(-1)!;
    const rulings = inWindow
        .filter(
            d =>
                d.source === statute.delegation.source &&
                d.series === statute.delegation.series &&
                d.issued_date >= statute.delegation.min_date
        )
        .sort((a, b) => a.issued_date.localeCompare(b.issued_date));

    const quotas = { ...statute.default_quota };
    const certs: Record<
        string,
        { discount: number; waives_carbon: boolean; mode?: string; from?: string; amended_discount?: number; amended_waives?: boolean }
    > = {};
    const voidClauses: string[] = [];

    for (const r of rulings) {
        if ('quotas' in r && r.quotas) Object.assign(quotas, r.quotas);
        if ('certs' in r && r.certs) for (const [k, v] of Object.entries(r.certs)) certs[k] = { ...v };
        if ('cert_amendments' in r && r.cert_amendments) {
            for (const [k, v] of Object.entries(r.cert_amendments)) {
                certs[k] = { ...certs[k]!, mode: v.mode, from: v.from, amended_discount: v.discount, amended_waives: v.waives_carbon };
            }
        }
        if ('attempted_statutory_overrides' in r && r.attempted_statutory_overrides) voidClauses.push(...r.attempted_statutory_overrides);
    }

    const shipment_statuses: Record<string, string> = {};
    const shipment_duties: Record<string, number> = {};
    for (const s of shipments) {
        const q = quotas[s.commodity];
        const inQuota = Math.min(s.tons, q),
            overQuota = Math.max(0, s.tons - q);
        const c = certs[s.cert]!;
        let certState = 'VALID_ORIGINAL',
            discount = c.discount,
            waivesCarbon = c.waives_carbon;
        if (c.from && s.arrival_date >= c.from && c.mode) {
            certState = c.mode;
            discount = c.amended_discount!;
            waivesCarbon = c.amended_waives!;
        }
        const base = statute.base_rate[s.commodity],
            carbon = statute.carbon_fee[s.commodity];
        const duty =
            inQuota * (base - discount) + overQuota * (base * statute.over_quota_multiplier) + (waivesCarbon ? 0 : s.tons * carbon);
        shipment_statuses[s.id] = `${certState}:${overQuota > 0 ? 'OVER_QUOTA' : 'IN_QUOTA'}`;
        shipment_duties[s.id] = duty;
    }

    return {
        governing_doc_ids: [statute.doc_id, ...rulings.map(r => r.doc_id)],
        effective_quotas: quotas,
        shipment_statuses,
        shipment_duties,
        total_duty: Object.values(shipment_duties).reduce((a, b) => a + b, 0),
        void_clauses_in_governing_docs: voidClauses.sort()
    };
}
function incidentSlaArbitrationOracle() {
    const cutoff = '2026-09-30';
    const incidents = [
        { id: 'INC-1', cluster: 'CORE', date: '2026-08-03', raw_downtime_min: 40, notice_hours: 24, reboot_min: 0 },
        { id: 'INC-2', cluster: 'CORE', date: '2026-08-16', raw_downtime_min: 55, notice_hours: 12, reboot_min: 52 },
        { id: 'INC-3', cluster: 'EDGE', date: '2026-08-21', raw_downtime_min: 50, notice_hours: 96, reboot_min: 0 },
        { id: 'INC-4', cluster: 'EDGE', date: '2026-08-17', raw_downtime_min: 35, notice_hours: 6, reboot_min: 30 }
    ] as const;

    const docs = [
        {
            doc_id: 'M1',
            source: 'MASTER_ADDENDUM',
            recorded_date: '2026-01-10',
            series: 'SLA-2026-MASTER',
            threshold: { CORE: 10, EDGE: 15 },
            rate: { CORE: 20, EDGE: 12 },
            repeat_surcharge: { CORE: 150, EDGE: 80 },
            cap: { CORE: 1400, EDGE: 600 },
            maint_notice_hours: 72,
            maint_deduction_min: 30,
            sec_series: 'SB-2026-SEC',
            max_reboot_min: 45,
            arb_series: 'ARB-2026-BIND'
        },
        { doc_id: 'M2', source: 'STATUS_POSTMORTEM', recorded_date: '2026-08-05', series: 'PM-2026-88' },
        {
            doc_id: 'M3',
            source: 'SECURITY_BULLETIN',
            recorded_date: '2026-08-14',
            series: 'SB-2026-SEC',
            exempt_candidates: ['INC-2', 'INC-4'],
            ultra_vires_clauses: ['M3:SEC_3_CORE_RATE']
        },
        { doc_id: 'M4', source: 'SECURITY_BULLETIN', recorded_date: '2026-08-20', series: 'SB-2026-OPS' },
        {
            doc_id: 'M5',
            source: 'ARBITRATION_ORDER',
            recorded_date: '2026-09-18',
            series: 'ARB-2026-BIND',
            sections: [
                { id: 'M5:PART_A_INC2_REVOCATION', ratified: true, incident: 'INC-2', revoke_sec: true, adjusted_raw: 50 },
                { id: 'M5:PART_B_INC3_WAIVER_REVOKE', ratified: true, incident: 'INC-3', disallow_maint: true },
                { id: 'M5:PART_C_INC4_STAYED_DRAFT', ratified: false, incident: 'INC-4', revoke_sec: true }
            ]
        },
        { doc_id: 'M6', source: 'ARBITRATION_ORDER', recorded_date: '2026-10-04', series: 'ARB-2026-BIND' },
        { doc_id: 'M7', source: 'STATUS_POSTMORTEM', recorded_date: '2026-09-01', series: 'PM-2026-92' }
    ];

    const inWindow = docs.filter(d => d.recorded_date <= cutoff);
    const master = inWindow.find(
        (d): d is Extract<(typeof docs)[number], { threshold: object }> => d.source === 'MASTER_ADDENDUM' && d.threshold !== undefined
    )!;
    const bulletins = inWindow.filter(d => d.source === 'SECURITY_BULLETIN' && d.series === master.sec_series);
    const orders = inWindow.filter(d => d.source === 'ARBITRATION_ORDER' && d.series === master.arb_series);

    const voidOrStayed: string[] = [];
    const secExempt = new Set<string>();
    for (const b of bulletins) {
        if ('ultra_vires_clauses' in b && b.ultra_vires_clauses) voidOrStayed.push(...b.ultra_vires_clauses);
        for (const id of b.exempt_candidates ?? []) {
            const inc = incidents.find(item => item.id === id)!;
            if (inc.reboot_min > 0 && inc.reboot_min <= master.max_reboot_min) secExempt.add(id);
        }
    }

    const rawOverride = new Map<string, number>();
    const disallowMaint = new Set<string>();
    for (const o of orders) {
        for (const s of o.sections ?? []) {
            if (!s.ratified) {
                voidOrStayed.push(s.id);
                continue;
            }
            if (s.revoke_sec) secExempt.delete(s.incident);
            if (typeof s.adjusted_raw === 'number') rawOverride.set(s.incident, s.adjusted_raw);
            if (s.disallow_maint) disallowMaint.add(s.incident);
        }
    }

    const incident_classifications: Record<string, string> = {};
    const chargeable_minutes: Record<string, number> = {};
    const incident_credits: Record<string, number> = {};
    const seenChargeable = { CORE: 0, EDGE: 0 };
    const uncapped = { CORE: 0, EDGE: 0 };

    for (const inc of incidents) {
        if (secExempt.has(inc.id)) {
            incident_classifications[inc.id] = 'SECURITY_EXEMPT';
            chargeable_minutes[inc.id] = 0;
            incident_credits[inc.id] = 0;
            continue;
        }
        const raw = rawOverride.get(inc.id) ?? inc.raw_downtime_min;
        const deduct = inc.notice_hours >= master.maint_notice_hours && !disallowMaint.has(inc.id) ? master.maint_deduction_min : 0;
        const afterMaint = Math.max(0, raw - deduct);
        const excess = Math.max(0, afterMaint - master.threshold[inc.cluster]);
        chargeable_minutes[inc.id] = excess;
        if (excess === 0) {
            incident_classifications[inc.id] = 'BELOW_THRESHOLD';
            incident_credits[inc.id] = 0;
        } else {
            seenChargeable[inc.cluster] += 1;
            const repeat = seenChargeable[inc.cluster] >= 2;
            const credit = excess * master.rate[inc.cluster] + (repeat ? master.repeat_surcharge[inc.cluster] : 0);
            incident_classifications[inc.id] = repeat ? 'CHARGEABLE_REPEAT' : 'CHARGEABLE_PRIMARY';
            incident_credits[inc.id] = credit;
            uncapped[inc.cluster] += credit;
        }
    }

    return {
        governing_doc_ids: [master.doc_id, ...bulletins.map(b => b.doc_id), ...orders.map(o => o.doc_id)],
        incident_classifications,
        chargeable_minutes,
        incident_credits,
        cluster_payable: {
            CORE: Math.min(master.cap.CORE, uncapped.CORE),
            EDGE: Math.min(master.cap.EDGE, uncapped.EDGE)
        },
        void_or_stayed_clauses: voidOrStayed.sort()
    };
}
describe('Assessment 2.1 independent interactive oracles', () => {
    const replay = [causalOutputs, codeOutputs, schedulerOutputs];
    for (let index = 0; index < inputs.length; index++)
        test(inputs[index].bank_id + ' candidate matrices and identifying probes', () => {
            const task = tasks.get(inputs[index].bank_id)! as any,
                config = task.grading.config;
            for (const [id, candidate] of Object.entries<any>(config.candidates))
                expect(replay[index]!(inputs[index].cases, Number(id.slice(1)))).toEqual(candidate.outputs);
            const caseIds = inputs[index].cases.map((entry: any) => entry.case_id) as string[];
            const chooseProbe = (remaining: string[], budget: number): string | null => {
                if (remaining.length <= 1 || budget === 0) return null;
                for (const caseId of caseIds) {
                    const groups = new Map<string, string[]>();
                    for (const id of remaining) {
                        const output = JSON.stringify(config.candidates[id].outputs[caseId]);
                        groups.set(output, [...(groups.get(output) ?? []), id]);
                    }
                    if (
                        groups.size > 1 &&
                        [...groups.values()].every(group => group.length === 1 || chooseProbe(group, budget - 1) !== null)
                    )
                        return caseId;
                }
                return null;
            };
            const ids = Object.keys(config.candidates),
                probeBudget = config.query_limit - 1;
            expect(chooseProbe(ids, probeBudget - 1)).toBeNull();
            expect(chooseProbe(ids, probeBudget)).not.toBeNull();
            for (const target of ids) {
                // Independently verify the complete decision tree for every possible hidden rule.
                const targetSimulator = new BlackboxAssessmentSimulator({ ...config, expected_candidate: target });
                let remaining = ids;
                for (let depth = 0; remaining.length > 1 && depth < probeBudget; depth++) {
                    const case_id = chooseProbe(remaining, probeBudget - depth)!;
                    const result = targetSimulator.call('probe_case', { case_id });
                    remaining = remaining.filter(
                        id => JSON.stringify(config.candidates[id].outputs[case_id]) === JSON.stringify(result.output)
                    );
                }
                expect(remaining).toEqual([target]);
                targetSimulator.call('submit_candidate', { candidate_id: remaining[0] });
                expect(targetSimulator.grade(JSON.stringify({ candidate_id: remaining[0] })).content_score).toBe(1);
            }
        });
    test('X2_Bounded_Doc_Tariff_Supersession', () =>
        expect(tariffSupersessionOracle()).toEqual((tasks.get('X2_Bounded_Doc_Tariff_Supersession') as any).grading.config.expected));
    test('X2_Bounded_Doc_Incident_SLA_Arbitration', () =>
        expect(incidentSlaArbitrationOracle()).toEqual(
            (tasks.get('X2_Bounded_Doc_Incident_SLA_Arbitration') as any).grading.config.expected
        ));
});
