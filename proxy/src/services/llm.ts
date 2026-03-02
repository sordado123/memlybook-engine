import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

type Provider = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'mistral' | 'groq' | 'zhipu'

/**
 * OpenAI-compatible providers — these all share the same SDK interface,
 * just with a different baseURL.
 */
const OPENAI_COMPATIBLE_PROVIDERS: Record<string, string> = {
    deepseek: 'https://api.deepseek.com/v1',
    mistral: 'https://api.mistral.ai/v1',
    groq: 'https://api.groq.com/openai/v1',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
}

function detectProvider(modelBase: string): Provider {
    if (modelBase.startsWith('claude')) return 'anthropic'
    if (modelBase.startsWith('gpt') || modelBase.startsWith('o1') || modelBase.startsWith('o3') || modelBase.startsWith('o4')) return 'openai'
    if (modelBase.startsWith('gemini')) return 'google'
    if (modelBase.startsWith('deepseek')) return 'deepseek'
    if (modelBase.startsWith('mistral') || modelBase.startsWith('codestral') || modelBase.startsWith('ministral') || modelBase.startsWith('devstral')) return 'mistral'
    if (modelBase.startsWith('llama') || modelBase.startsWith('mixtral') || modelBase.startsWith('gemma')) return 'groq'
    if (modelBase.startsWith('glm')) return 'zhipu'
    throw new Error(`[LLM] Unknown provider for model: ${modelBase}`)
}

// ── Timeout utility ───────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`[LLM] Timeout after ${ms}ms: ${label}`)), ms)
        )
    ])
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Invoke any supported LLM with the operator's API key.
 * Provider is auto-detected from modelBase prefix.
 *
 * Supported providers (Feb 2026):
 *  - OpenAI          (gpt-5, gpt-4.1, o4-mini, etc.)
 *  - Anthropic       (claude-sonnet-4.6, claude-haiku-4.5, etc.)
 *  - Google Gemini   (gemini-2.5-pro, gemini-2.5-flash, etc.)
 *  - DeepSeek        (deepseek-chat [V3.2], deepseek-reasoner [R1], etc.)
 *  - Mistral         (mistral-large-latest, mistral-small-latest, etc.)
 *  - Groq            (llama-3.3-70b-versatile, llama-3.1-8b-instant, etc.)
 *  - Zhipu / z.ia    (glm-4-plus, glm-4-flash, etc.)
 */
export async function invokeGenericLLM(
    apiKey: string,
    modelBase: string,
    prompt: string,
    maxTokens: number = 1000,
    timeoutMs: number = 30_000,
    isJson: boolean = false
): Promise<string> {
    const provider = detectProvider(modelBase)
    console.log(`[LLM] Invoking ${provider} with model ${modelBase}`)

    // ── Anthropic ─────────────────────────────────────────────────────────────
    if (provider === 'anthropic') {
        const client = new Anthropic({ apiKey })
        try {
            const response = await withTimeout(
                client.messages.create({
                    model: modelBase,
                    max_tokens: maxTokens,
                    messages: [{ role: 'user', content: prompt }]
                }),
                timeoutMs,
                `anthropic/${modelBase}`
            )
            const block = response.content[0]
            if (block.type !== 'text') throw new Error('[LLM] Unexpected non-text response from Anthropic')
            return block.text
        } catch (err: any) {
            throw new Error(`Anthropic API error: ${err.message || err.toString()}`)
        }
    }

    // ── Google Gemini (REST — no additional SDK dependency) ───────────────────
    if (provider === 'google') {
        const res = await withTimeout(
            fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${modelBase}:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { maxOutputTokens: maxTokens }
                    })
                }
            ),
            timeoutMs,
            `google/${modelBase}`
        )
        if (!res.ok) {
            const err = await res.text()
            throw new Error(`[LLM] Google API error ${res.status}: ${err.slice(0, 200)}`)
        }
        const data = await res.json() as any
        return (data.candidates?.[0]?.content?.parts?.[0]?.text as string) ?? ''
    }

    // ── OpenAI + OpenAI-compatible providers ─────────────────────────────────
    const baseURL = OPENAI_COMPATIBLE_PROVIDERS[provider]
    const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })

    try {
        // GPT-5 series uses max_completion_tokens instead of max_tokens
        const isGPT5 = modelBase.startsWith('gpt-5') || modelBase.startsWith('o1') || modelBase.startsWith('o3') || modelBase.startsWith('o4')
        const tokenParam = isGPT5 ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }

        const response = await withTimeout(
            client.chat.completions.create({
                model: modelBase,
                ...tokenParam,
                ...(isJson ? { response_format: { type: 'json_object' } } : {}),
                messages: [{ role: 'user', content: prompt }]
            }),
            timeoutMs,
            `${provider}/${modelBase}`
        )
        return response.choices[0].message.content ?? ''
    } catch (err: any) {
        // Enhanced error messages for common API issues
        if (err.status === 401) {
            throw new Error(`${provider} API key is invalid or expired`)
        }
        if (err.status === 404) {
            throw new Error(`Model '${modelBase}' not found on ${provider}`)
        }
        if (err.status === 429) {
            throw new Error(`${provider} rate limit exceeded`)
        }
        if (err.message?.includes('Timeout')) {
            throw new Error(`${provider} API timeout after ${timeoutMs}ms`)
        }
        throw new Error(`${provider} API error: ${err.message || err.toString()}`)
    }
}
