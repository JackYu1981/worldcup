/**
 * Match data schema — canonical field definitions, validation, normalization.
 * All adapters must output data conforming to this schema.
 */

export const MATCH_FIELDS = {
  id:       { type: 'string', required: true },
  code:     { type: 'string', required: false, default: '000' },
  period:   { type: 'string', required: true, default: null },  // YYYY-MM-DD 竞彩期次（开奖日，等于500.com kaijiang.php?d=X 中的X）
  league:   { type: 'string', required: false, default: '其他' },
  home:     { type: 'string', required: true },
  away:     { type: 'string', required: true },
  kickoff:  { type: 'string', required: true },   // "YYYY-MM-DD HH:MM" 比赛开赛时间（北京时间）
  date:     { type: 'string', required: false, default: null },  // @deprecated 保留兼容历史数据，新数据不再写入
  status:   { type: 'string', required: false, default: 'scheduled', enum: ['scheduled', 'live', 'finished', 'postponed', 'cancelled'] },
  score:    { type: 'string', required: false, default: null },  // "H-A" 90分钟全场比分（竞彩开奖用，权威源：开奖页 kaijiang.php）
  score_ht: { type: 'string', required: false, default: null },  // "H-A" 半场比分（竞猜半场玩法用，括号内值）
  odds: {
    type: 'object',
    required: false,
    default: { home_win: null, draw: null, away_win: null },
    fields: {
      home_win: { type: 'number', required: false, default: null },
      draw:     { type: 'number', required: false, default: null },
      away_win: { type: 'number', required: false, default: null },
    }
  },
  handicap: {
    type: 'object',
    required: false,
    default: { line: 0, home_win: null, draw: null, away_win: null },
    fields: {
      line:     { type: 'number', required: false, default: 0 },
      home_win: { type: 'number', required: false, default: null },
      draw:     { type: 'number', required: false, default: null },
      away_win: { type: 'number', required: false, default: null },
    }
  }
};

export function normalizeMatch(raw) {
  const match = {};

  for (const [field, spec] of Object.entries(MATCH_FIELDS)) {
    if (spec.type === 'object') {
      match[field] = {};
      const src = raw[field] || {};
      for (const [subField, subSpec] of Object.entries(spec.fields)) {
        const val = src[subField];
        match[field][subField] = coerce(val, subSpec.type, subSpec.default);
      }
    } else {
      const val = raw[field];
      match[field] = coerce(val, spec.type, spec.default ?? null);
    }
  }

  return match;
}

export function validateMatch(match) {
  const errors = [];

  for (const [field, spec] of Object.entries(MATCH_FIELDS)) {
    if (spec.type === 'object') continue;
    if (spec.required && (match[field] === null || match[field] === undefined || match[field] === '')) {
      errors.push(`Missing required field: ${field}`);
    }
    if (spec.enum && match[field] && !spec.enum.includes(match[field])) {
      errors.push(`Invalid value for ${field}: "${match[field]}". Expected one of: ${spec.enum.join(', ')}`);
    }
  }

  if (match.date && !/^\d{4}-\d{2}-\d{2}$/.test(match.date)) {
    errors.push(`Invalid date format: "${match.date}". Expected YYYY-MM-DD`);
  }
  if (match.kickoff && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(match.kickoff)) {
    errors.push(`Invalid kickoff format: "${match.kickoff}". Expected "YYYY-MM-DD HH:MM"`);
  }
  if (match.period && !/^\d{4}-\d{2}-\d{2}$/.test(match.period)) {
    errors.push(`Invalid period format: "${match.period}". Expected YYYY-MM-DD`);
  }
  if (match.score !== null && !/^\d+-\d+$/.test(match.score)) {
    errors.push(`Invalid score format: "${match.score}". Expected "H-A"`);
  }

  return { valid: errors.length === 0, errors };
}

export function createEnvelope(period, source, matches) {
  return {
    period,
    source,
    fetched_at: new Date().toISOString().replace(/Z$/, '+00:00'),
    match_count: matches.length,
    matches
  };
}

function coerce(value, type, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  switch (type) {
    case 'number': {
      const n = Number(value);
      return isNaN(n) ? fallback : n;
    }
    case 'string':
      return String(value);
    default:
      return value;
  }
}
