// @ts-check
/**
 * The providers the app offers.
 *
 * The list is deliberately small: the three providers the product names, plus
 * MiniMax's China region, because a MiniMax key is region-specific and a
 * user with the wrong one gets an authentication error that looks like a
 * bad key.
 *
 * The ids are Pi's own provider ids. They are what the credential store is
 * keyed by, what the model catalogue reports, and what the backend's
 * credential lookup resolves — so they must match exactly.
 */
export interface ProviderDescriptor {
  /** Pi's provider id. This is the credential's key. */
  readonly id: string;
  /** The name shown to the user. */
  readonly name: string;
  /** What the provider is for, in one line. */
  readonly description: string;
  /** The environment variable Pi would read, when the key came from there. */
  readonly envVar: string;
  /** Where the provider's API lives, so the user can find the right key. */
  readonly keyUrl: string;
}

/** The providers the settings page offers, in the order it shows them. */
export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek chat and reasoning models.',
    envVar: 'DEEPSEEK_API_KEY',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'minimax',
    name: 'MiniMax (international)',
    description: 'MiniMax models on the international region.',
    envVar: 'MINIMAX_API_KEY',
    keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  },
  {
    id: 'minimax-cn',
    name: 'MiniMax (China)',
    description: 'MiniMax models on the China region.',
    envVar: 'MINIMAX_CN_API_KEY',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'OpenAI chat and reasoning models.',
    envVar: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
];

/** The provider with this id, when the app offers it. */
export function findProvider(providerId: string): ProviderDescriptor | undefined {
  return PROVIDERS.find((provider) => provider.id === providerId);
}

/** The provider ids the app offers. */
export const PROVIDER_IDS: readonly string[] = PROVIDERS.map((provider) => provider.id);
