// ported-from: packages/desktop/src/common/chartConfigParser.ts @ 762abb777
/**
 * Shared chart parser used by both renderer import and main-process validation.
 * Accepts strict JSON plus a minimal YAML-like format commonly emitted by agents.
 */

type ParsedChartConfig = {
  valid: boolean;
  value?: unknown;
  error?: string;
  format?: 'json' | 'yaml';
};

const KEY_VALUE_RE = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/;

const parseScalar = (rawValue: string): unknown => {
  const value = rawValue.trim();
  const lowerValue = value.toLowerCase();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  if (lowerValue === 'true') return true;
  if (lowerValue === 'false') return false;
  if (lowerValue === 'null') return null;

  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }

  return value;
};

const parseYamlLikeChart = (rawText: string): ParsedChartConfig => {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n');
  const config: Record<string, unknown> = {};
  let section: 'data' | 'options' | null = null;
  let currentDataPoint: Record<string, unknown> | null = null;
  let sawRootField = false;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();

    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;

    if (indent === 0) {
      const rootMatch = trimmed.match(KEY_VALUE_RE);
      if (!rootMatch) {
        return {
          valid: false,
          error: `Invalid chart format at line ${index + 1}`
        };
      }

      sawRootField = true;
      section = null;
      currentDataPoint = null;

      const [, key, rawValue] = rootMatch;
      if (rawValue.length === 0) {
        if (key === 'data') {
          config.data = [];
          section = 'data';
          continue;
        }

        if (key === 'options') {
          config.options = {};
          section = 'options';
          continue;
        }

        config[key] = '';
        continue;
      }

      config[key] = parseScalar(rawValue);
      continue;
    }

    if (section === 'data') {
      if (!Array.isArray(config.data)) {
        return {
          valid: false,
          error: `Invalid data section at line ${index + 1}`
        };
      }

      if (trimmed.startsWith('- ')) {
        const inline = trimmed.slice(2).trim();
        const point: Record<string, unknown> = {};
        if (inline.length > 0) {
          const inlineMatch = inline.match(KEY_VALUE_RE);
          if (!inlineMatch) {
            return {
              valid: false,
              error: `Invalid data item at line ${index + 1}`
            };
          }
          point[inlineMatch[1]] = parseScalar(inlineMatch[2]);
        }

        config.data.push(point);
        currentDataPoint = point;
        continue;
      }

      const pointMatch = trimmed.match(KEY_VALUE_RE);
      if (!pointMatch || !currentDataPoint) {
        return {
          valid: false,
          error: `Invalid data field at line ${index + 1}`
        };
      }

      currentDataPoint[pointMatch[1]] = parseScalar(pointMatch[2]);
      continue;
    }

    if (section === 'options') {
      if (!config.options || typeof config.options !== 'object' || Array.isArray(config.options)) {
        return {
          valid: false,
          error: `Invalid options section at line ${index + 1}`
        };
      }

      const optionMatch = trimmed.match(KEY_VALUE_RE);
      if (!optionMatch) {
        return {
          valid: false,
          error: `Invalid options field at line ${index + 1}`
        };
      }

      (config.options as Record<string, unknown>)[optionMatch[1]] = parseScalar(optionMatch[2]);
      continue;
    }

    return {
      valid: false,
      error: `Unexpected indentation at line ${index + 1}`
    };
  }

  if (!sawRootField) {
    return { valid: false, error: 'Chart configuration is empty' };
  }

  return { valid: true, value: config, format: 'yaml' };
};

export const parseChartConfigBlock = (rawText: string): ParsedChartConfig => {
  const text = rawText.trim();
  if (text.length === 0) {
    return { valid: false, error: 'Chart configuration is empty' };
  }

  try {
    return {
      valid: true,
      value: JSON.parse(text),
      format: 'json'
    };
  } catch (jsonError) {
    const yamlResult = parseYamlLikeChart(text);
    if (yamlResult.valid) {
      return yamlResult;
    }

    return {
      valid: false,
      error: `Invalid JSON: ${jsonError instanceof Error ? jsonError.message : 'Parse error'}`
    };
  }
};
