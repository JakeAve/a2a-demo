// Subscription-backed Claude agents via the Claude Agent SDK.
// Prefers a Claude Code OAuth token, falls back to an Anthropic API key.

export function resolveClaudeCodeEnv(
  baseEnv: Record<string, string>,
  oauthToken: string,
  apiKey: string,
): Record<string, string> {
  const env = { ...baseEnv };
  if (oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    delete env.ANTHROPIC_API_KEY;
  } else if (apiKey) {
    env.ANTHROPIC_API_KEY = apiKey;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    throw new Error(
      "claude-code backend requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY",
    );
  }
  return env;
}
