import './env.js';

const DEEPSEEK_ENDPOINT = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

export function hasDeepSeekKey() {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}

export async function callDeepSeekJson({ system, user, temperature = 0.2, maxTokens = 900, thinking = 'disabled' }) {
  if (!hasDeepSeekKey()) {
    throw new Error('DEEPSEEK_API_KEY is not configured');
  }

  const response = await fetch(DEEPSEEK_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      response_format: { type: 'json_object' },
      thinking: { type: thinking },
      temperature,
      max_tokens: maxTokens,
      stream: false
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepSeek request failed: ${response.status} ${text.slice(0, 180)}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    const finishReason = choice?.finish_reason ?? 'unknown';
    const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    throw new Error(`DeepSeek returned empty content (finish_reason=${finishReason}, reasoning_tokens=${reasoningTokens})`);
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`DeepSeek returned invalid JSON: ${content.slice(0, 180)}`);
  }
}
