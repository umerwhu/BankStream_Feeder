const DURATION_UNITS = { s: 1_000, m: 60_000, h: 3_600_000 };

function parseDuration(value) {
  if (value === 'unlimited') return Infinity;
  const match = /^(\d+)([smh])$/i.exec(value || '');
  if (!match || Number(match[1]) < 1) throw new Error(`Invalid duration "${value}". Use a positive value such as 30s, 5m, 1h, or unlimited.`);
  const duration = Number(match[1]) * DURATION_UNITS[match[2].toLowerCase()];
  if (!Number.isSafeInteger(duration)) throw new Error(`Duration "${value}" is too large.`);
  return duration;
}

function parseInterval(value) {
  const match = /^(\d+)([smh])$/i.exec(value || '');
  if (!match || Number(match[1]) < 1) throw new Error(`Invalid interval "${value}". Use a positive value such as 5s, 15s, or 1m.`);
  const interval = Number(match[1]) * DURATION_UNITS[match[2].toLowerCase()];
  if (!Number.isSafeInteger(interval)) throw new Error(`Interval "${value}" is too large.`);
  return interval;
}

function parseRealtimeArgs(args) {
  const options = { durationMs: 5 * 60_000, intervalMs: 15_000, eventsPerCycle: 1, help: false };
  const names = { '--duration': 'duration', '--interval': 'interval', '--events-per-cycle': 'eventsPerCycle' };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--help' || name === '-h') { options.help = true; continue; }
    if (!names[name]) throw new Error(`Unknown option "${name}". Use --help to see available options.`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}.`);
    if (names[name] === 'duration') options.durationMs = parseDuration(value);
    if (names[name] === 'interval') options.intervalMs = parseInterval(value);
    if (names[name] === 'eventsPerCycle') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) throw new Error('--events-per-cycle must be a positive safe integer.');
      options.eventsPerCycle = Number(value);
    }
  }
  return options;
}

const helpText = `Usage: npm run realtime -- [options]

Options:
  --duration <Ns|Nm|Nh|unlimited>  Runtime (default: 5m)
  --interval <Ns|Nm|Nh>            Delay between cycles (default: 15s)
  --events-per-cycle <number>      Events to generate per cycle (default: 1)
  --help                           Show this help`;

function validateHostedRealtimeOptions(input = {}, policy = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['durationMs', 'intervalMs', 'eventsPerCycle'].includes(key))) throw new Error('Invalid realtime options');
  const { durationMs = 300000, intervalMs = 15000, eventsPerCycle = 1 } = input;
  if (!Number.isSafeInteger(durationMs) || durationMs < 1000 || durationMs > Math.min(policy.maxDurationMs ?? 3600000, 3600000)) throw new Error('Remote duration exceeds its allowed range; unlimited is not supported');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < Math.max(policy.minIntervalMs ?? 1000, 1000) || intervalMs > 3600000) throw new Error('Remote interval exceeds its allowed range');
  if (!Number.isSafeInteger(eventsPerCycle) || eventsPerCycle < 1 || eventsPerCycle > Math.min(policy.maxEventsPerCycle ?? 10, 10)) throw new Error('Remote events-per-cycle exceeds its allowed range');
  return { durationMs, intervalMs, eventsPerCycle };
}
module.exports = { parseDuration, parseInterval, parseRealtimeArgs, helpText, validateHostedRealtimeOptions };
