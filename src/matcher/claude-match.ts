import { ClaudeMatchResult } from '../types.js';

const OPENCLAW_API_BASE = process.env.OPENCLAW_GATEWAY_URL
  ? `${process.env.OPENCLAW_GATEWAY_URL}/v1`
  : 'http://127.0.0.1:16862/v1';
const OPENCLAW_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '832bb3640279ac11d7b4ed0f0293984186fdf355442180ab';
const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are an expert vinyl record database assistant. 
Given an eBay listing title, extract the vinyl record metadata.

Respond ONLY with a JSON object (no markdown, no explanation) in this exact format:
{
  "artist": "Artist Name",
  "album": "Album Title",
  "year": 1975,
  "label": "Label Name",
  "confidence": "high"
}

confidence must be one of: "high", "medium", "low"
- "high": clear artist + album, unambiguous
- "medium": probable match but some uncertainty
- "low": too vague, acronyms only, or multiple possible matches

year and label are optional (use null if unknown).
If the title is not about a vinyl record at all, return confidence: "low".`;

/**
 * Use Claude (via OpenClaw proxy) to parse an eBay listing title
 * and extract vinyl record metadata.
 */
export async function parseEbayTitle(title: string): Promise<ClaudeMatchResult | null> {
  try {
    const response = await fetch(`${OPENCLAW_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 256,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: `Parse this eBay vinyl listing title:\n\n"${title}"`,
          },
        ],
        system: SYSTEM_PROMPT,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Claude API error ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content ?? '';

    // Strip any accidental markdown code fences
    const cleaned = content.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const parsed = JSON.parse(cleaned) as {
      artist?: string;
      album?: string;
      year?: number | null;
      label?: string | null;
      confidence?: string;
    };

    if (!parsed.artist || !parsed.album) {
      console.log(`[claude] Missing artist/album in response for: "${title}"`);
      return null;
    }

    const confidence = parsed.confidence as ClaudeMatchResult['confidence'];
    if (!['high', 'medium', 'low'].includes(confidence)) {
      return null;
    }

    return {
      artist: parsed.artist,
      album: parsed.album,
      year: parsed.year ?? undefined,
      label: parsed.label ?? undefined,
      confidence,
    };
  } catch (err) {
    console.error(`[claude] Error parsing title "${title}":`, err);
    return null;
  }
}
