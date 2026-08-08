import { createInterface } from "node:readline/promises";
import type { AuthEvent, AuthInteraction, AuthPrompt, Models } from "@earendil-works/pi-ai";
import { theme } from "../tui/theme.js";

/**
 * A terminal implementation of pi-ai's login interaction.
 *
 * OAuth flows call `notify` to hand us a URL and `prompt` to ask for whatever
 * the provider needs back. Keeping it on plain stdin/stdout rather than the TUI
 * means login works the same over SSH, in a pipe, and inside the dashboard.
 */
export function terminalInteraction(signal?: AbortSignal): AuthInteraction {
  const write = (text: string) => process.stdout.write(text);

  return {
    ...(signal ? { signal } : {}),

    notify(event: AuthEvent): void {
      switch (event.type) {
        case "auth_url":
          write(`\n${theme.strong("Open this URL to authorize:")}\n\n  ${theme.accent(event.url)}\n\n`);
          if (event.instructions) write(`${theme.dim(event.instructions)}\n`);
          break;
        case "device_code":
          write(
            `\n${theme.strong("Open")} ${theme.accent(event.verificationUri)}\n` +
              `${theme.strong("and enter code")} ${theme.accent(event.userCode)}\n\n`,
          );
          break;
        case "info":
          write(`${theme.dim(event.message)}\n`);
          for (const link of event.links ?? []) {
            write(`  ${theme.dim(link.label ? `${link.label}: ` : "")}${theme.accent(link.url)}\n`);
          }
          break;
        case "progress":
          write(`${theme.dim(`… ${event.message}`)}\n`);
          break;
      }
    },

    async prompt(prompt: AuthPrompt): Promise<string> {
      if (prompt.type === "select") {
        write(`\n${prompt.message}\n`);
        prompt.options.forEach((option, index) => {
          write(`  ${theme.accent(String(index + 1))}. ${option.label}`);
          write(option.description ? ` ${theme.dim(option.description)}\n` : "\n");
        });
        const answer = await ask(`Choose [1-${prompt.options.length}]: `, prompt.signal ?? signal);
        const chosen = prompt.options[Number(answer) - 1] ?? prompt.options[0];
        if (!chosen) throw new Error("No options offered by the provider");
        return chosen.id;
      }

      const suffix = "placeholder" in prompt && prompt.placeholder ? theme.dim(` (${prompt.placeholder})`) : "";
      return ask(`${prompt.message}${suffix}: `, prompt.signal ?? signal);
    },
  };
}

async function ask(question: string, signal?: AbortSignal): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = signal ? await rl.question(question, { signal }) : await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

export interface ProviderAuthStatus {
  providerId: string;
  configured: boolean;
  /** "OAuth", "OPENAI_API_KEY", … — where the credential came from. */
  source?: string;
  type?: "api_key" | "oauth";
}

export async function authStatus(models: Models, providerIds: string[]): Promise<ProviderAuthStatus[]> {
  const out: ProviderAuthStatus[] = [];
  for (const providerId of providerIds) {
    try {
      const check = await models.checkAuth(providerId);
      out.push({
        providerId,
        configured: check !== undefined,
        ...(check?.source ? { source: check.source } : {}),
        ...(check?.type ? { type: check.type } : {}),
      });
    } catch {
      out.push({ providerId, configured: false });
    }
  }
  return out;
}

/**
 * Whether a provider bills per token or is covered by a subscription.
 *
 * This is not cosmetic: under a subscription the per-call price is zero, so
 * everything the budget reports is a list-price estimate rather than money
 * actually spent. Saying otherwise would make the ¥ figure a lie.
 */
export async function isSubscriptionAuth(models: Models, providerId: string): Promise<boolean> {
  try {
    const check = await models.checkAuth(providerId);
    if (check?.type !== "oauth") return false;
    // Every OAuth provider pi-ai ships for OpenAI/Anthropic/Copilot is a
    // consumer subscription; API keys are the metered path.
    return true;
  } catch {
    return false;
  }
}
