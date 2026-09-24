// Native Gemini adapter. Personal BYOK only: keys stay in local extension storage.
// A fixed model avoids silently switching to a differently priced model.
const Gemini = (() => {
  const DEFAULT_MODEL = "gemini-3.5-flash-lite";

  async function chat(prompt, key, maxTokens, model, request) {
    model = (model || DEFAULT_MODEL).trim().replace(/^models\//, "");
    if (!/^gemini-[a-z0-9.-]+$/.test(model)) {
      throw new Error("Enter a Gemini model ID, such as " + DEFAULT_MODEL + ".");
    }
    const generationConfig = { maxOutputTokens: Math.max(1024, maxTokens || 0) };
    if (/^gemini-3/.test(model)) {
      generationConfig.thinkingConfig = { thinkingLevel: "LOW" };
    } else if (/^gemini-2\.5-flash/.test(model)) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
    const res = await request(
      "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig })
      },
      15000
    );
    // Do not echo provider error bodies: they can contain submitted data.
    if (res.status === 401 || res.status === 403) {
      throw new Error("Gemini rejected access. Check your AI Studio key and its API restrictions.");
    }
    if (res.status === 429) {
      throw new Error("Gemini quota reached. Check limits in AI Studio or try again later.");
    }
    if (res.status === 404) {
      throw new Error("Gemini model unavailable. Update the model ID in Settings.");
    }
    if (res.status === 400) {
      throw new Error("Gemini rejected the request. Check your key, model ID and regional availability.");
    }
    if (!res.ok) throw new Error("Gemini returned HTTP " + res.status + ". Try again later.");
    const data = await res.json();
    const candidate = data.candidates?.[0];
    if (data.promptFeedback?.blockReason || (candidate?.finishReason && candidate.finishReason !== "STOP")) {
      throw new Error(candidate?.finishReason === "MAX_TOKENS"
        ? "Gemini reached its output limit before finishing. Try a faster model in Settings."
        : "Gemini did not return a usable answer for this request.");
    }
    // Never treat thoughts, blocked output, or a truncated verdict as an answer.
    const text = (candidate?.content?.parts || [])
      .filter(part => !part.thought && typeof part.text === "string")
      .map(part => part.text).join("").trim();
    if (!text) throw new Error("Gemini returned an empty answer.");
    return text;
  }
  return { DEFAULT_MODEL, chat };
})();

if (typeof module !== "undefined") module.exports = Gemini;
