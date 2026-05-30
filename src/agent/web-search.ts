// Pluggable web-search providers. A provider is just a function that turns a
// query into results, so swapping the backend (Ollama's hosted API today; a
// keyless DuckDuckGo scrape, a self-hosted SearXNG, or Tavily/Brave tomorrow)
// is a one-function change — the agent code only sees `WebSearchProvider`.

export type SearchResult = { title: string; url: string; content: string };

export type WebSearchProvider = (
  query: string,
  maxResults?: number,
) => Promise<SearchResult[]>;

// Config fields a provider might need. Extend as new providers are added
// (e.g. searxngUrl, tavilyApiKey) without touching the agent backends.
export type SearchConfig = {
  ollamaApiKey?: string;
  // future: searxngUrl?: string; tavilyApiKey?: string; ...
};

// Ollama's hosted web search API (https://ollama.com/api/web_search).
// `endpoint` is injectable so tests can point it at a local stub.
export function ollamaSearchProvider(
  apiKey: string,
  endpoint = "https://ollama.com/api/web_search",
): WebSearchProvider {
  return async (query, maxResults = 5) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, max_results: maxResults }),
    });
    if (!res.ok) throw new Error(`ollama web_search ${res.status}`);
    const json = await res.json();
    return (json.results ?? []).map((r: Record<string, unknown>) => ({
      title: String(r.title ?? ""),
      url: String(r.url ?? ""),
      content: typeof r.content === "string"
        ? r.content
        : JSON.stringify(r.content ?? ""),
    }));
  };
}

// Pick a provider from config. Returns undefined when none is configured, in
// which case web_search simply isn't offered to agents. Add new branches here
// as providers are implemented.
export function selectSearchProvider(
  cfg: SearchConfig,
): WebSearchProvider | undefined {
  if (cfg.ollamaApiKey) return ollamaSearchProvider(cfg.ollamaApiKey);
  return undefined;
}
