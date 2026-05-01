import 'dotenv/config';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { canSpendAnthropic, logSpend, calcLLMCost } from './budget.js';
import { logger } from './logger.js';

const mimo = new OpenAI({
  apiKey: process.env.MIMO_API_KEY || 'placeholder',
  baseURL: process.env.MIMO_BASE_URL,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function mimoChat({ messages, pro = false, agent = '?', purpose = '', maxTokens = parseInt(process.env.MIMO_MAX_TOKENS_FAST || '512'), temperature = 0.1 }) {
  const model = pro ? process.env.MIMO_MODEL_PRO : process.env.MIMO_MODEL_FAST;
  try {
    const res = await mimo.chat.completions.create({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    });
    const u = res.usage || { prompt_tokens: 0, completion_tokens: 0 };
    const cost = calcLLMCost(model, u.prompt_tokens, u.completion_tokens);
    await logSpend({ resource: 'mimo', amountUsd: cost, tokensIn: u.prompt_tokens, tokensOut: u.completion_tokens, purpose: `${agent}:${purpose}` });
    return { text: res.choices[0].message.content, usage: u, cost, model };
  } catch (e) {
    logger.error(`mimoChat failed: ${e.message}`, { agent, purpose });
    throw e;
  }
}

export async function claudeJudge({ system, messages, agent = '?', purpose = '', maxTokens = 1024 }) {
  const model = process.env.ANTHROPIC_MODEL;
  const estimatedCost = calcLLMCost(model, 4000, maxTokens);
  const gate = await canSpendAnthropic(estimatedCost);

  if (!gate.ok) {
    logger.warn(`claude blocked, falling back to mimo pro: ${gate.reason}`);
    return await mimoChat({
      messages: [{ role: 'system', content: system }, ...messages],
      pro: true,
      agent,
      purpose: `${purpose} (claude-fallback)`,
      maxTokens,
    });
  }

  try {
    const res = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages,
    });
    const u = res.usage;
    const cost = calcLLMCost(model, u.input_tokens, u.output_tokens);
    await logSpend({ resource: 'anthropic', amountUsd: cost, tokensIn: u.input_tokens, tokensOut: u.output_tokens, purpose: `${agent}:${purpose}` });
    return { text: res.content[0].text, usage: u, cost, model };
  } catch (e) {
    logger.error(`claudeJudge failed: ${e.message}`, { agent, purpose });
    throw e;
  }
}

export function parseJSON(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    logger.warn(`JSON parse failed: ${e.message}`);
    return null;
  }
}
