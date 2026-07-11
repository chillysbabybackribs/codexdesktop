#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const discoveryRoot = path.resolve(process.argv[2] || '');
if (!discoveryRoot || !fs.existsSync(discoveryRoot)) {
  console.error('usage: node audit-phase0.mjs <hunts/.../discovery-or-phase-0>');
  process.exit(2);
}

const readJsonl = file => {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${file}:${index + 1}: ${error.message}`);
    }
  });
};

const workspaceRoot = process.cwd();
const runRoot = path.dirname(path.dirname(discoveryRoot));
const agentsRoot = path.join(discoveryRoot, 'agents');
const laneDirs = fs.existsSync(agentsRoot)
  ? fs.readdirSync(agentsRoot, {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name)
  : [];

const records = laneDirs.flatMap(lane =>
  readJsonl(path.join(agentsRoot, lane, 'records.jsonl')).map(record => ({...record, _laneDir: lane}))
);

const candidateArtifacts = [
  path.join(discoveryRoot, 'signals.jsonl'),
  path.join(discoveryRoot, 'normalized.jsonl')
];
if (!records.length) {
  for (const file of candidateArtifacts) {
    records.push(...readJsonl(file).map(record => ({...record, _laneDir: record.sourceLane || 'merged'})));
  }
}

function artifactExists(record) {
  if (!record.artifactPath) return null;
  const candidates = path.isAbsolute(record.artifactPath)
    ? [record.artifactPath]
    : [path.resolve(workspaceRoot, record.artifactPath), path.resolve(runRoot, record.artifactPath)];
  return candidates.some(fs.existsSync);
}

const requiredFields = ['recordId', 'source', 'url', 'observedAt', 'sourceLane', 'retrievalStatus'];
const audited = records.map(record => {
  const missingRequiredFields = requiredFields.filter(field => record[field] == null || record[field] === '');
  const artifactStatus = artifactExists(record);
  return {
    recordId: record.recordId || null,
    lane: record._laneDir,
    source: record.source || null,
    url: record.url || null,
    retrievalStatus: record.retrievalStatus || null,
    missingRequiredFields,
    artifactDeclared: Boolean(record.artifactPath),
    artifactExists: artifactStatus,
    hasUsableSignal: Boolean(record.sourcedFact || record.textExcerpt || record.commercialMetric || record.remainingManualWork || record.objection || record.requestedOutcome || record.agentInference || record.opportunityTheme),
    classificationConfidence: record.classificationConfidence || null,
    hasClassificationReason: Boolean(record.classificationReason),
    independenceKey: record.independenceKey || null
  };
});

const count = predicate => audited.filter(predicate).length;
const structuralErrors = audited.filter(record => record.missingRequiredFields.length);
const brokenArtifactReferences = audited.filter(record => record.artifactDeclared && record.artifactExists === false);
const duplicateRecordIds = [...new Set(audited.map(record => record.recordId).filter(Boolean).filter((id, index, all) => all.indexOf(id) !== index))];

const byLane = Object.fromEntries([...new Set(audited.map(record => record.lane))].map(lane => [lane, {
  records: count(record => record.lane === lane),
  retrievedVerified: count(record => record.lane === lane && record.retrievalStatus === 'verified'),
  usableSignals: count(record => record.lane === lane && record.hasUsableSignal),
  lowOrUnspecifiedConfidence: count(record => record.lane === lane && (!record.classificationConfidence || record.classificationConfidence === 'low')),
  brokenArtifactReferences: count(record => record.lane === lane && record.artifactDeclared && record.artifactExists === false)
}]));

const warnings = [
  ...(!records.length ? ['No discovery records found; this may be valid for an interrupted run.'] : []),
  ...(count(record => !record.hasUsableSignal) ? [`${count(record => !record.hasUsableSignal)} records contain no excerpt, metric, pain, or requested outcome.`] : []),
  ...(count(record => !record.independenceKey) ? [`${count(record => !record.independenceKey)} records have no independence key; review finalist evidence for duplication.`] : []),
  ...(count(record => !record.classificationConfidence || record.classificationConfidence === 'low') ? [`${count(record => !record.classificationConfidence || record.classificationConfidence === 'low')} records are low-confidence or unclassified; they may inspire candidates but should not be presented as strong evidence.`] : [])
];

const errors = [
  ...(structuralErrors.length ? [`${structuralErrors.length} records are missing required provenance fields.`] : []),
  ...(brokenArtifactReferences.length ? [`${brokenArtifactReferences.length} declared artifact paths do not exist.`] : []),
  ...(duplicateRecordIds.length ? [`${duplicateRecordIds.length} duplicate record IDs found.`] : [])
];

const output = {
  schemaVersion: 2,
  purpose: 'structural-and-provenance-check',
  auditedAt: new Date().toISOString(),
  discoveryRoot: path.relative(workspaceRoot, discoveryRoot),
  totals: {
    records: audited.length,
    retrievedVerified: count(record => record.retrievalStatus === 'verified'),
    usableSignals: count(record => record.hasUsableSignal),
    lowOrUnspecifiedConfidence: count(record => !record.classificationConfidence || record.classificationConfidence === 'low'),
    brokenArtifactReferences: brokenArtifactReferences.length
  },
  byLane,
  duplicateRecordIds,
  errors,
  warnings,
  verdict: errors.length ? 'FAIL' : 'PASS'
};

fs.writeFileSync(path.join(discoveryRoot, 'audit.json'), JSON.stringify(output, null, 2) + '\n');
fs.writeFileSync(path.join(discoveryRoot, 'audit-records.jsonl'), audited.map(record => JSON.stringify(record)).join('\n') + (audited.length ? '\n' : ''));
console.log(JSON.stringify({
  ok: output.verdict === 'PASS',
  verdict: output.verdict,
  records: audited.length,
  errors,
  warnings,
  artifacts: {
    audit: path.join(discoveryRoot, 'audit.json'),
    records: path.join(discoveryRoot, 'audit-records.jsonl')
  }
}, null, 2));

process.exitCode = output.verdict === 'PASS' ? 0 : 1;
