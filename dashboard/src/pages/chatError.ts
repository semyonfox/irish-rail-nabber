import { ApiError } from "../graphql/api";

export function chatErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "Failed to get a reply from the model.";
  }

  if (error.status === 429) {
    return "You’ve reached today’s request limit. It resets automatically, or you can upgrade for a larger allowance.";
  }

  if (error.code === "model_provider_rate_limited") {
    return "The rail assistant's model provider is busy right now. Try again in a moment.";
  }

  if (error.status === 408 || error.status === 504 || error.code === "chat_timeout") {
    return "The rail assistant took too long to reply. Try again.";
  }

  return error.message;
}
