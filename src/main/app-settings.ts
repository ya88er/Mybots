// @ts-check
/**
 * The app's own settings.
 *
 * These are the preferences that belong to the **desktop app**, not to the
 * Mini App: whether the app starts when the user signs in, and the language
 * the app's own windows use. The Mini App's own settings — the language of
 * the chat, for instance — stay in the upstream store and are not duplicated
 * here.
 *
 * The file is a plain JSON document, written atomically. A file that cannot be
 * parsed is treated as absent: a corrupted preferences file must never stop
 * the app from starting.
 */
import { AtomicJsonFile } from '../storage/atomic-json.ts';

export interface AppSettings {
  /**
   * Whether the app starts when the user signs in.
   *
   * The preference is remembered even when the app cannot apply it — in a
   * development run, for instance, where Electron's login-item settings would
   * register `electron.exe` instead of the app.
   */
  readonly startAtLogin: boolean;
  /** The language the app's own windows use. */
  readonly locale: 'auto' | 'en' | 'zh';
  /** Whether the app's window was open when it was last closed. */
  readonly startMinimized: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  startAtLogin: false,
  locale: 'auto',
  startMinimized: false,
};

/** The app's settings store. */
export class SettingsStore {
  readonly #file: AtomicJsonFile<AppSettings>;
  #settings: AppSettings = DEFAULT_SETTINGS;

  constructor(path: string) {
    this.#file = new AtomicJsonFile<AppSettings>(path);
  }

  /** The current settings. */
  get current(): AppSettings {
    return this.#settings;
  }

  /** Read the settings, falling back to the defaults. */
  async load(): Promise<AppSettings> {
    const stored = await this.#file.read(DEFAULT_SETTINGS);
    this.#settings = {
      startAtLogin: stored.startAtLogin === true,
      locale: stored.locale === 'en' || stored.locale === 'zh' ? stored.locale : 'auto',
      startMinimized: stored.startMinimized === true,
    };
    return this.#settings;
  }

  /** Change one setting and write the file. */
  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.#settings = { ...this.#settings, ...patch };
    await this.#file.write(this.#settings);
    return this.#settings;
  }
}
