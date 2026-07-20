import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('hunts/2026-07-11-5/phase-0');
const runRoot = path.dirname(root);
const statePath = path.join(runRoot, 'state.md');
const lanes = ['commercial-motion', 'formation-feedback', 'buyer-reality'];

const readJsonl = file => {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\n/).filter(Boolean).map(JSON.parse);
};

const writeJsonl = (file, rows) =>
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));

const records = lanes.flatMap(lane =>
  readJsonl(path.join(root, 'agents', lane, 'records.jsonl')).map(record => ({...record, _laneDir: lane}))
);

const hostFromUrl = url => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
};

const slug = value =>
  String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

const seenIds = new Set();
const seenUrls = new Set();
const normalized = records.map(record => {
  const duplicateId = seenIds.has(record.recordId);
  const duplicateUrl = seenUrls.has(record.url);
  seenIds.add(record.recordId);
  seenUrls.add(record.url);
  return {
    ...record,
    parentAudit: {
      duplicateId,
      duplicateUrl
    }
  };
});
writeJsonl(path.join(root, 'normalized.jsonl'), normalized);

const entities = normalized
  .filter(record => record.startupName || record.productDomain)
  .map(record => ({
    entityId: slug(record.productDomain || record.startupName),
    startupName: record.startupName || null,
    productDomain: record.productDomain || null,
    founderHandle: record.founderHandle || null,
    sourceLane: record.sourceLane,
    recordId: record.recordId,
    independenceKey: record.independenceKey,
    commercialMetric: record.commercialMetric || null
  }));
writeJsonl(path.join(root, 'entities.jsonl'), entities);

const jobs = normalized
  .filter(record => record.firsthand && record.repeatedAction)
  .map(record => ({
    recordId: record.recordId,
    sourceLane: record.sourceLane,
    source: record.source,
    url: record.url,
    independenceKey: record.independenceKey,
    complete: Boolean(record.buyer && record.trigger && record.input && record.output && record.destination),
    jobSentence: `${record.buyer || '[buyer unknown]'} + ${record.trigger || '[trigger unstated]'} + ${record.input || '[input unstated]'} + ${record.repeatedAction} + ${record.output || '[output unstated]'} + ${record.destination || '[destination unstated]'}`,
    priceOrWage: record.priceOrWage || null,
    textExcerpt: record.textExcerpt || null
  }));
writeJsonl(path.join(root, 'job-sentences.jsonl'), jobs);

const clusterDefs = [
  {
    id: 'finance-backoffice-operations',
    label: 'Finance back-office operations',
    re: /\b(accounting|bookkeep|quickbooks|reconcile|invoice|receipt|expense|financial report|tally|spreadsheet)\b/i
  },
  {
    id: 'payroll-tax-compliance',
    label: 'Payroll, tax, and compliance operations',
    re: /\b(payroll|tax|itr|jahresabschluss|compliance|audit|vat|deduction|filing|finanzamt)\b/i
  },
  {
    id: 'general-admin-outsourcing',
    label: 'General admin and assistant outsourcing',
    re: /\b(assistant|administrative|data entry|virtual assistant|project management|manual|organi[sz]e)\b/i
  }
];

const searchableText = record =>
  [
    record.source,
    record.startupName,
    record.productDomain,
    record.buyer,
    record.trigger,
    record.input,
    record.repeatedAction,
    record.output,
    record.destination,
    record.remainingManualWork,
    record.requestedOutcome,
    record.textExcerpt,
    record.commercialMetric?.category,
    ...(record.currentTools || [])
  ]
    .filter(Boolean)
    .join(' ');

const clusters = clusterDefs.map(def => {
  const matches = normalized.filter(record => def.re.test(searchableText(record)));
  const byLane = Object.fromEntries(
    ['commercial_motion', 'formation_feedback', 'buyer_reality'].map(lane => [
      lane,
      matches.filter(record => record.sourceLane === lane).length
    ])
  );
  return {
    clusterId: def.id,
    label: def.label,
    method: 'bounded lexical suggestion; parent gate still requires exact-job validation',
    recordIds: matches.map(record => record.recordId),
    byLane,
    independentDomains: [...new Set(matches.map(record => hostFromUrl(record.url)))].sort(),
    firsthandCount: matches.filter(record => record.firsthand).length,
    exactMoneyCount: matches.filter(record => ['exact_job_budget', 'exact_job_spend', 'exact_job_wage'].includes(record.moneyType)).length,
    warning:
      'Keyword clustering is a discovery convenience only. Shared terms do not prove a single repeated job or a qualified market-motion intersection.'
  };
});
writeJsonl(path.join(root, 'clusters.jsonl'), clusters);

const fail = reason => ({pass: false, recordIds: [], reason});
const intersections = [
  {
    intersectionId: 'ix-finance-backoffice-ops',
    clusterId: 'finance-backoffice-operations',
    score: null,
    scoreStatus: 'HARD_REQUIREMENTS_FAILED',
    status: 'WATCH',
    requirements: {
      independentDomains: fail('Buyer reality is concentrated in two freelance marketplaces and HN remains a separate formation lane.'),
      actorTypes: fail('Buyer briefs dominate buyer reality, but the cluster lacks a second actor type tied to the exact same job.'),
      motionProducts: fail('TrustMRR products are category-adjacent, not two independently verified products serving the exact bookkeeping/reconciliation job.'),
      commercialMetric: fail('No exact-job product metric was validated for the same workflow described in the buyer records.'),
      firsthandWork: {
        pass: false,
        recordIds: normalized.filter(record => record.sourceLane === 'buyer_reality').slice(0, 2).map(record => record.recordId),
        reason: 'There are many firsthand purchase briefs, but they are heterogeneous outsourcing jobs rather than two validated records for one exact repeated workflow.'
      },
      exactJobMoney: {
        pass: false,
        recordIds: normalized.filter(record => record.sourceLane === 'buyer_reality' && ['exact_job_budget', 'exact_job_spend', 'exact_job_wage'].includes(record.moneyType)).slice(0, 3).map(record => record.recordId),
        reason: 'Exact budgets exist, but they span unrelated gigs and do not yet corroborate a single productizable workflow.'
      },
      catalyst: fail('The commercial lane provides only a same-day TrustMRR baseline, so acceleration cannot be claimed.'),
      jobSentence: fail('Most buyer records still leave `input` null, so complete job sentences remain rare.'),
      buyerChannel: {
        pass: true,
        recordIds: normalized.filter(record => record.sourceLane === 'buyer_reality').slice(0, 2).map(record => record.recordId),
        reason: 'Freelance marketplaces are a plausible solo-accessible buyer channel.'
      }
    },
    reason:
      'The run surfaced real paid finance/admin work, but the evidence still describes a broad outsourcing market rather than one exact software wedge with commercial acceleration.'
  },
  {
    intersectionId: 'ix-payroll-tax-compliance',
    clusterId: 'payroll-tax-compliance',
    score: null,
    scoreStatus: 'HARD_REQUIREMENTS_FAILED',
    status: 'WATCH',
    requirements: {
      independentDomains: fail('The workflow evidence is still concentrated in marketplaces plus HN, not three independent core domains for one exact job.'),
      actorTypes: fail('Buyer briefs are plentiful, but cross-actor corroboration for one exact job is missing.'),
      motionProducts: fail('No two independently verified motion products were tied to payroll/tax filing work specifically.'),
      commercialMetric: fail('TrustMRR provides category-level motion only; no exact payroll/tax product join was validated.'),
      firsthandWork: {
        pass: false,
        recordIds: normalized
          .filter(record => record.sourceLane === 'buyer_reality' && /\b(payroll|tax|itr|jahresabschluss|compliance)\b/i.test(searchableText(record)))
          .slice(0, 2)
          .map(record => record.recordId),
        reason: 'The buyer lane shows repeated willingness to pay, but the job scopes vary by jurisdiction, filing type, and service depth.'
      },
      exactJobMoney: {
        pass: false,
        recordIds: normalized
          .filter(record => record.sourceLane === 'buyer_reality' && /\b(payroll|tax|itr|jahresabschluss|compliance)\b/i.test(searchableText(record)) && ['exact_job_budget', 'exact_job_spend', 'exact_job_wage'].includes(record.moneyType))
          .slice(0, 3)
          .map(record => record.recordId),
        reason: 'Budgets are verified, but they do not collapse to a single repeatable job shape.'
      },
      catalyst: fail('No measurable longitudinal acceleration exists yet.'),
      jobSentence: fail('Most records are detailed briefs but still omit a normalized input field.'),
      buyerChannel: {
        pass: true,
        recordIds: normalized
          .filter(record => record.sourceLane === 'buyer_reality' && /\b(payroll|tax|itr|jahresabschluss|compliance)\b/i.test(searchableText(record)))
          .slice(0, 2)
          .map(record => record.recordId),
        reason: 'Freelance marketplaces and compliance communities remain plausible downstream channels.'
      }
    },
    reason:
      'This is a credible WATCH lane because the money is explicit, but the current run still cannot prove one exact workflow tied to accelerating commercial motion.'
  },
  {
    intersectionId: 'ix-general-admin-outsourcing',
    clusterId: 'general-admin-outsourcing',
    score: null,
    scoreStatus: 'UNJOINED',
    status: 'NO-GO',
    requirements: {
      join: fail('The cluster mixes unrelated assistant, data-entry, and project-admin tasks without an exact repeated job.')
    },
    reason: 'This is broad outsourcing residue, not a defendable single wedge.'
  }
];
writeJsonl(path.join(root, 'intersections.jsonl'), intersections);
writeJsonl(path.join(root, 'rejected-clusters.jsonl'), intersections.filter(intersection => intersection.status === 'NO-GO'));

const laneCounts = Object.fromEntries(
  lanes.map(lane => [lane, readJsonl(path.join(root, 'agents', lane, 'records.jsonl')).length])
);
const verified = normalized.filter(record => record.retrievalStatus === 'verified');
const exactMoney = normalized.filter(record => ['exact_job_budget', 'exact_job_spend', 'exact_job_wage'].includes(record.moneyType));
const qualifiedFirsthand = normalized.filter(
  record => record.firsthand && ['medium', 'high'].includes(record.classificationConfidence)
);
const qualifiedRepeatedWorkflow = normalized.filter(
  record => record.firsthand && record.repeatedAction && ['medium', 'high'].includes(record.classificationConfidence)
);
const completeJobs = jobs.filter(job => job.complete);
const sourceDomains = new Set(normalized.map(record => hostFromUrl(record.url)));

const coverage = {
  runId: '2026-07-11-5',
  totalRecords: normalized.length,
  laneRecords: laneCounts,
  retrievedVerifiedRecords: verified.length,
  uniqueIndependenceKeys: new Set(normalized.map(record => record.independenceKey)).size,
  sourceDomains: sourceDomains.size,
  exactMoneyObservations: exactMoney.length,
  completeJobSentences: completeJobs.length,
  qualifiedFirsthandRecords: qualifiedFirsthand.length,
  qualifiedRepeatedWorkflowRecords: qualifiedRepeatedWorkflow.length,
  qualifiedExactJobMoneyRecords: exactMoney.filter(record => ['medium', 'high'].includes(record.classificationConfidence)).length,
  trustMrrCoverage: {
    captured: laneCounts['commercial-motion'],
    available: 8272,
    percent: Number(((laneCounts['commercial-motion'] / 8272) * 100).toFixed(2)),
    rankOrderedTopHeavy: true,
    baseline: 'same-day-only'
  },
  sourceConcentration: {
    formationFeedbackPrimary: 'news.ycombinator.com / HN Algolia snapshots',
    buyerRealityPrimary: ['freelancer.com', 'peopleperhour.com'],
    commercialPrimary: 'trustmrr.com'
  },
  limitations: [
    'The commercial lane improved to 250 TrustMRR rows, but it is still a same-day comparison and cannot support 7/30/90/180-day acceleration claims.',
    'Formation/feedback coverage is materially larger than run 4 but still HN-centric, which makes supply and founder echo a continuing risk.',
    'Buyer reality now contains many exact-budget marketplace briefs, but most are heterogeneous service requests rather than one normalized repeated workflow.',
    'Marketplace briefs verify purchase intent, not completed payment or recurring software adoption.',
    'Most buyer records still leave `input` null, so complete job-sentence coverage remains well below the hard gate.',
    'Reddit occupational expansion hit blocking 403 responses, so forum diversity remains incomplete.'
  ],
  adaptiveStopping: {
    satisfied: false,
    reason: 'A stronger buyer lane emerged, but no independent batch resolved the commercial-motion join or complete-job-sentence gap.'
  },
  gate: 'INSUFFICIENT COVERAGE; zero GO intersections'
};
fs.writeFileSync(path.join(root, 'coverage.json'), JSON.stringify(coverage, null, 2) + '\n');

const directions = `# Phase 0 directions

## Accelerating commercial clusters

None defensibly established. TrustMRR coverage improved from the prior run, but the available comparison is still same-day only, so the parent cannot claim 7/30/90/180-day acceleration for any cluster.

## Early formation clusters

- **Finance back-office operations:** the buyer lane now shows repeated demand for bookkeeping, reconciliation, spreadsheet cleanup, reporting, and close-like tasks with explicit budgets, but the exact jobs are still heterogeneous.
- **Payroll, tax, and compliance operations:** verified buyer briefs repeatedly mention filing, payroll, tax optimization, annual statements, and compliance help, yet the work fragments by jurisdiction and service depth.
- **General admin outsourcing:** there is visible paid residue, but it spans too many unrelated assistant and data-entry tasks to support one wedge.

## Launch-heavy or evidence-light

- HN formation/feedback coverage is broad and useful for objections, but it remains a supply-heavy lane rather than direct buyer proof.
- TrustMRR shows adjacent commercial products, but the parent could not validate two exact-job products serving the same workflow surfaced in the buyer lane.

## WATCH directions retained

1. Finance back-office workflow software for small operators remains a WATCH because the run found many explicit budgets and manual spreadsheet/accounting residue.
2. Payroll/tax/compliance workflow software remains a WATCH because paid briefs are frequent, but the job must be narrowed to one repeatable wedge before any idea is promoted.

## Evidence gaps and downstream directives

- Take a later TrustMRR snapshot before making any market-motion acceleration claim.
- Expand buyer reality beyond freelance marketplaces into occupational communities, service forums, and any public job boards that expose repeated workflows with exact inputs.
- For each WATCH lane, require two firsthand records for the same exact job, one exact-job money observation, and two independently verified motion products before candidate invention.
- Do not proceed to idea promotion from this run: no intersection satisfies the hard \`GO\` gate.
`;
fs.writeFileSync(path.join(root, 'directions.md'), directions);

const gate = `# Phase 0 gate

## Decision: INSUFFICIENT COVERAGE — zero GO intersections

No intersection satisfies the contract. The decisive failures are:

- no defensible longitudinal commercial acceleration because the TrustMRR baseline is same-day only;
- no exact-job commercial join between TrustMRR motion products and the paid workflows surfaced in buyer reality;
- buyer-reality evidence is much stronger than the prior run, but it is concentrated in freelance marketplaces and remains heterogeneous;
- complete structured job sentences are still scarce because most buyer records do not normalize \`input\`;
- formation/feedback remains HN-centric, so founder/supply echo remains a material bias.

| Intersection | Scoring status | Result | Binding failure |
|---|---|---|---|
| Finance back-office operations | Hard requirements failed | WATCH | Exact budgets exist, but not for one validated workflow tied to two motion products |
| Payroll, tax, and compliance | Hard requirements failed | WATCH | Paid demand is explicit, but the workflow fragments across unrelated jurisdiction-specific jobs |
| General admin outsourcing | Unjoined | NO-GO | Broad service residue, no exact repeated job |

The skill requires the hunt to stop here. No product candidates were invented and no ideas were promoted.
`;
fs.writeFileSync(path.join(root, 'gate.md'), gate);

const runlog = `# Phase 0 runlog

- Parent merged ${normalized.length} normalized records across commercial, formation, and buyer lanes.
- Structural parent verdict: waiting on audit script output.
- Parent gate result: INSUFFICIENT COVERAGE with zero GO intersections.
- Strongest signal change vs prior run: buyer reality improved from thin forum residue to many explicit paid marketplace briefs, but the commercial-motion join remains unproven.
`;
fs.writeFileSync(path.join(root, 'runlog.md'), runlog);

const state = `# Studio Hunt 2026-07-11-5

- Status: phase-0-gated
- Started: 2026-07-11
- Prior run: \`hunts/2026-07-11-4\` (eval-failed; raw records are not carried forward as qualified evidence)
- Contract: \`skills/studio-hunt/references/phase0-agent-contract.md\`
- Auditor: \`skills/studio-hunt/scripts/audit-phase0.mjs\`
- Current boundary: parent merge complete; Phase 0 gate is \`INSUFFICIENT COVERAGE\` with zero promoted ideas.
`;
fs.writeFileSync(statePath, state);

console.log(
  JSON.stringify(
    {
      runId: '2026-07-11-5',
      records: normalized.length,
      laneCounts,
      gate: coverage.gate,
      artifacts: {
        normalized: path.join(root, 'normalized.jsonl'),
        coverage: path.join(root, 'coverage.json'),
        directions: path.join(root, 'directions.md'),
        gate: path.join(root, 'gate.md')
      }
    },
    null,
    2
  )
);
