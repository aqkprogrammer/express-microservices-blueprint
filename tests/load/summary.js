// Shared k6 end-of-test summary. Writes a JSON report WITHOUT `setup_data`
// (which would contain the load-test users' access tokens) and prints a compact
// table, using no remote modules.
const pick = (metric, keys) =>
  keys
    .filter((key) => metric.values[key] !== undefined)
    .map(
      (key) =>
        `${key}=${typeof metric.values[key] === 'number' ? metric.values[key].toFixed(2) : metric.values[key]}`,
    )
    .join(' ');

export function buildSummary(name) {
  return function handleSummary(data) {
    const { setup_data: _omitted, ...safe } = data;
    const lines = [`\n${name} summary`];
    for (const [metricName, metric] of Object.entries(data.metrics)) {
      if (
        !/^(http_reqs|http_req_failed|http_req_duration|iterations|dropped_iterations|checks)/.test(
          metricName,
        )
      )
        continue;
      lines.push(
        `  ${metricName.padEnd(42)} ${pick(metric, ['count', 'rate', 'avg', 'med', 'p(90)', 'p(95)', 'max', 'passes', 'fails'])}`,
      );
      if (metric.thresholds) {
        for (const [threshold, result] of Object.entries(metric.thresholds))
          lines.push(`    ${result.ok ? 'PASS' : 'FAIL'} ${threshold}`);
      }
    }
    return {
      stdout: `${lines.join('\n')}\n`,
      [`/results/${name}-summary.json`]: JSON.stringify(safe, null, 2),
    };
  };
}
