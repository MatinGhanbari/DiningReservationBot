import type { AssistantGateway } from '../domain/ports';
import type { ChatTurn } from '../domain/models';
import { UpstreamRejectedError, UpstreamUnavailableError } from '../shared/errors';
import { readTextWithLimit } from '../shared/http';
import { scopedLogger } from '../shared/logger';
import { buildSystemPrompt } from './knowledge';

const log = scopedLogger('chatbot');

interface OpenRouterChoice {
  message?: { content?: unknown };
  finish_reason?: unknown;
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  error?: { message?: unknown; code?: unknown };
}

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** Sent as X-Title so the usage shows up under this app in the dashboard. */
  appName?: string;
}

/**
 * The language model behind the support chatbot, via OpenRouter.
 *
 * OpenRouter is used rather than a single provider's SDK because it exposes a
 * uniform chat-completions endpoint over many models, which means the free model
 * can be swapped by configuration alone when one is retired or rate-limited —
 * and free models do get retired often.
 */
export class OpenRouterAssistant implements AssistantGateway {
  constructor(private readonly options: OpenRouterOptions) {}

  async answer(input: { question: string; history: readonly ChatTurn[] }): Promise<string> {
    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      ...input.history.map(turn => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: input.question },
    ];

    const response = await fetch(`${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
        'x-title': this.options.appName ?? 'dining-reservation-bot',
      },
      body: JSON.stringify({
        model: this.options.model,
        messages,
        // Low temperature: this is a support desk, not a creative writing tool,
        // and a wandering answer is worse than a short one.
        temperature: 0.2,
        max_tokens: 600,
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
      // The key is in the Authorization header, so a redirect to another host
      // must not be followed.
      redirect: 'manual',
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);

      // 429 is the expected outcome on a free model, and it is worth a distinct
      // message because the fix is different: wait, rather than report a bug.
      if (response.status === 429) {
        throw new UpstreamUnavailableError({
          message: `OpenRouter rate limited the request: ${detail}`,
          userMessage:
            'الان سرِ شلوغیِ چت‌باته و نوبتم نشد. چند دقیقه دیگه امتحان کن، یا از گزینهٔ «پیام به پشتیبانی» استفاده کن.',
          context: { status: response.status },
        });
      }

      throw new UpstreamUnavailableError({
        message: `OpenRouter responded with ${response.status}: ${detail}`,
        userMessage:
          'چت‌بات الان در دسترس نیست. می‌تونی از گزینهٔ «پیام به پشتیبانی» استفاده کنی تا اپراتور جوابت رو بده.',
        context: { status: response.status },
      });
    }

    const body = JSON.parse(await readTextWithLimit(response)) as OpenRouterResponse;

    if (typeof body.error?.message === 'string') {
      throw new UpstreamRejectedError(
        `OpenRouter returned an error payload: ${body.error.message}`,
        'چت‌بات الان در دسترس نیست. می‌تونی از گزینهٔ «پیام به پشتیبانی» استفاده کنی تا اپراتور جوابت رو بده.',
      );
    }

    const content = body.choices?.[0]?.message?.content;

    if (typeof content !== 'string' || content.trim().length === 0) {
      log.warn({ finishReason: body.choices?.[0]?.finish_reason }, 'chatbot returned no usable content');

      throw new UpstreamRejectedError(
        'OpenRouter returned an empty completion',
        'نتونستم جوابی پیدا کنم. یه‌بار دیگه بپرس، یا از گزینهٔ «پیام به پشتیبانی» استفاده کن.',
      );
    }

    return content.trim();
  }
}

/**
 * Pulls whatever explanation the upstream offered, without trusting its shape.
 *
 * The detail is truncated because it goes into a log line, and an upstream error
 * body can echo back the request — which for this call includes the prompt and
 * the API key's owner.
 */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await readTextWithLimit(response, 8 * 1024);
    return text.slice(0, 300);
  } catch {
    return 'no body';
  }
}
