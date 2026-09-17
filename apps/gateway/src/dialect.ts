import type { Provider } from "./db";

export type ApiDialect = "chat" | "messages" | "responses";

export const API_PATH: Record<ApiDialect, string> = {
  chat: "/v1/chat/completions",
  messages: "/v1/messages",
  responses: "/v1/responses",
};

export function upstreamUrl(provider: Provider, api: ApiDialect): string {
  return `${provider.base_url.replace(/\/$/, "")}${API_PATH[api]}`;
}

export function applyAuth(h: Headers, provider: Provider, api: ApiDialect): void {
  if (api === "messages") {
    h.set("x-api-key", provider.api_key);
    h.set("anthropic-version", "2023-06-01");
  } else {
    h.set("Authorization", `Bearer ${provider.api_key}`);
  }
}