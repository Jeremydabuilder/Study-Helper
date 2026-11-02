import { ChatGPTTransport } from './chatgpt';
import type { ChatGPTConnection } from '../server/personal/chatgpt';
import type { AppConfig } from '../server/services/common';
import { GROQ_DEFAULT_MODEL, GroqTransport } from './groq';
import { AnthropicTransport, DEFAULT_TASKS, LLMProvider, TaskConfigs } from './llm';

/**
 * Exactly one provider is active per server process, chosen by the operator's environment. Student material is
 * only ever sent to that provider; there is no automatic fallback or switching between providers.
 */
export function buildProvider(cfg: AppConfig, chatgpt?: ChatGPTConnection): LLMProvider | null {
  const tasks: Partial<TaskConfigs> = {};
  for (const k of ['extract', 'generate', 'grade'] as const) tasks[k] = { ...DEFAULT_TASKS[k], ...cfg.aiTasks[k] };
  if (cfg.aiProvider === 'chatgpt') {
    if (!chatgpt?.model) return null;
    for (const k of ['extract', 'generate', 'grade'] as const) tasks[k] = { ...DEFAULT_TASKS[k], model: chatgpt.model };
    return new LLMProvider(new ChatGPTTransport(chatgpt), { timeoutMs: cfg.aiTimeoutMs, tasks });
  }
  if (cfg.aiProvider === 'groq') {
    if (!cfg.groqKey) return null;
    return new LLMProvider(new GroqTransport(cfg.groqKey, cfg.groqModel ?? GROQ_DEFAULT_MODEL), { timeoutMs: cfg.aiTimeoutMs, tasks });
  }
  if (!cfg.anthropicKey) return null;
  return new LLMProvider(new AnthropicTransport(cfg.anthropicKey, cfg.model, fetch, cfg.anthropicBaseUrl), { timeoutMs: cfg.aiTimeoutMs, tasks, ocr: cfg.ocr.enabled ? { model: cfg.ocr.model ?? undefined, maxOutputTokens: cfg.ocr.maxOutputTokens } : undefined });
}
