import type { AppConfig } from '../server/services/common';
import { GroqTransport } from './groq';
import { AnthropicTransport, DEFAULT_TASKS, LLMProvider, TaskConfigs } from './llm';

/**
 * Exactly one provider is active per server process, chosen by the operator's environment. Student material is
 * only ever sent to that provider; there is no automatic fallback or switching between providers.
 */
export function buildProvider(cfg: AppConfig): LLMProvider | null {
  const tasks: Partial<TaskConfigs> = {};
  for (const k of ['extract', 'generate', 'grade'] as const) tasks[k] = { ...DEFAULT_TASKS[k], ...cfg.aiTasks[k] };
  if (cfg.aiProvider === 'groq') {
    if (!cfg.groqKey || !cfg.groqModel) return null;
    return new LLMProvider(new GroqTransport(cfg.groqKey, cfg.groqModel), { timeoutMs: cfg.aiTimeoutMs, tasks });
  }
  if (!cfg.anthropicKey) return null;
  return new LLMProvider(new AnthropicTransport(cfg.anthropicKey, cfg.model, fetch, cfg.anthropicBaseUrl), { timeoutMs: cfg.aiTimeoutMs, tasks });
}
