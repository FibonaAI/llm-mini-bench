import { observationPickerRecords } from './data-adapter.js';
import { assessmentChartMetric, observationSampleAnomalies } from './assessment-chart-metric.js';

/**
 * Derive observation metrics independently of chart presentation. Each instance owns
 * its cache: observation-array replacement and the ordered official task IDs are
 * source inputs; cost/tokens have separate entries. Callers replace observations
 * after fetching, rather than mutating samples in place. Theme, color, filters,
 * selected IDs, log scale, and history membership are deliberately not inputs.
 */
export function createAnalysisModel({ mapObservations = observationPickerRecords, deriveMetric = assessmentChartMetric } = {}) {
  let observations = null,
    records = [],
    expectedTaskIds = null,
    bankVersion = null,
    bankKey = 'null';
  const axes = new Map();
  return {
    /** New server response identity invalidates mapped identities and both axis metrics. */
    setObservations(value) {
      if (value === observations) return;
      observations = value;
      records = mapObservations(value).map(record => ({
        ...record,
        sampleAnomalies: observationSampleAnomalies(record.original)
      }));
      axes.clear();
    },
    /** Only official task membership/order affects metrics; labels/theme do not. */
    setBank(bank) {
      const ids = typeof bank?.version === 'string' && Array.isArray(bank.tasks) ? bank.tasks.map(task => task.id) : null;
      const key = JSON.stringify([ids && bank.version, ids]);
      if (key === bankKey) return;
      bankKey = key;
      expectedTaskIds = ids;
      bankVersion = ids ? bank.version : null;
      axes.clear();
    },
    /** Return stable derived records for one axis, preserving repeats and raw originals. */
    records(axis = 'cost') {
      const key = axis === 'tokens' ? 'tokens' : axis === 'duration' ? 'duration' : 'cost';
      if (!axes.has(key))
        axes.set(
          key,
          records.map(record => ({ ...record, ...deriveMetric(record.original, expectedTaskIds, key, bankVersion) }))
        );
      return axes.get(key);
    }
  };
}

/** Attach batch IDs only; history is not metric evidence and never rescans samples. */
export function attachAnalysisBatchIds(records, getTaskId) {
  return records.map(record => {
    const taskId = record.original.task_id || getTaskId(record.run_id);
    return taskId === record.task_id ? record : { ...record, task_id: taskId };
  });
}
