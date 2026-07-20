import type { Model } from '../../shared/session-protocol/index.js';

export const claudeDefaultModelId = 'claude-default';
const claudeModelPrefix = 'claude:';

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ClaudeSdkModelInfo = {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: ClaudeEffort[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
};

export function claudeModelId(runtimeModel: string): string {
  return `${claudeModelPrefix}${encodeURIComponent(runtimeModel)}`;
}

export function isClaudeModelId(model: string | null | undefined): boolean {
  return (
    model === claudeDefaultModelId ||
    model?.startsWith(claudeModelPrefix) === true ||
    model?.startsWith('claude-') === true
  );
}

export function claudeRuntimeModel(model: string | null | undefined): string | null {
  if (!model || model === claudeDefaultModelId) return null;
  if (!model.startsWith(claudeModelPrefix)) return model;
  try {
    return decodeURIComponent(model.slice(claudeModelPrefix.length)) || null;
  } catch {
    return null;
  }
}

export function normalizeClaudeEffort(effort: string | null | undefined): ClaudeEffort | null {
  return effort === 'low' ||
    effort === 'medium' ||
    effort === 'high' ||
    effort === 'xhigh' ||
    effort === 'max'
    ? effort
    : null;
}

export function claudeDefaultModel(): Model {
  return {
    id: claudeDefaultModelId,
    model: claudeDefaultModelId,
    providerId: 'claude',
    runtimeModel: '',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'Claude Code default',
    description: 'Uses the default model selected by your Claude Code account and policy.',
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'high',
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    supportsFastMode: false,
    supportsAdaptiveThinking: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  };
}

export function mapClaudeModel(info: ClaudeSdkModelInfo): Model {
  const effortLevels =
    info.supportsEffort === false ? [] : [...new Set(info.supportedEffortLevels ?? [])];
  const defaultEffort = effortLevels.includes('high') ? 'high' : (effortLevels[0] ?? 'high');
  const model = info.value === 'default' ? claudeDefaultModelId : claudeModelId(info.value);
  return {
    id: model,
    model,
    providerId: 'claude',
    runtimeModel: info.value,
    resolvedModel: info.resolvedModel,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: info.displayName,
    description:
      info.resolvedModel && info.resolvedModel !== info.value
        ? `${info.description} Resolves to ${info.resolvedModel}.`
        : info.description,
    hidden: false,
    supportedReasoningEfforts: effortLevels.map((reasoningEffort) => ({
      reasoningEffort,
      description: claudeEffortDescription(reasoningEffort),
    })),
    defaultReasoningEffort: defaultEffort,
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    supportsFastMode: info.supportsFastMode === true,
    supportsAdaptiveThinking: info.supportsAdaptiveThinking === true,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  };
}

export function buildClaudeModelCatalog(infos: ClaudeSdkModelInfo[]): Model[] {
  const models = new Map<string, Model>();
  models.set(claudeDefaultModelId, claudeDefaultModel());
  for (const info of infos) {
    if (!info.value.trim()) continue;
    const model = mapClaudeModel(info);
    models.set(model.model, model);
  }
  return [...models.values()];
}

function claudeEffortDescription(effort: ClaudeEffort): string {
  return {
    low: 'Minimal thinking for the fastest response',
    medium: 'Moderate thinking for routine work',
    high: 'Deep reasoning for complex work',
    xhigh: 'Extra-deep reasoning for difficult work',
    max: 'Maximum available reasoning effort',
  }[effort];
}
