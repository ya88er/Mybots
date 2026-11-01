// @ts-check
/**
 * The credential service.
 *
 * A provider key must never be written in plain text, must never appear in a
 * log, a snapshot, an SSE event or a URL, and must never reach the renderer.
 *
 * The path is:
 *
 * 1. The renderer submits a key through a dedicated preload method. It is not
 *    part of the MiniBots settings document, so it cannot leak through the
 *    HTTP snapshot.
 * 2. Electron main encrypts it with the operating system's key store and
 *    stores only the encrypted bytes.
 * 3. Main hands the resolved credential to the backend over private IPC.
 * 4. The backend supplies the key to Pi through its in-memory runtime
 *    credential API. No plaintext Pi auth file is written.
 *
 * Electron 45 deprecates the synchronous `safeStorage` methods and removes
 * them in Electron 46, and `encryptStringAsync` returns an **object** whose
 * `result` holds the ciphertext — not a string. Both are handled here.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The `safeStorage` surface this service needs. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(cipherText: Buffer): string;
  /**
   * Electron 45's async API.
   *
   * `encryptStringAsync` returns an **object** whose `result` holds the
   * ciphertext; `decryptStringAsync` returns an object whose `result` holds
   * the plaintext. The sync methods are deprecated and removed in Electron 46.
   */
  encryptStringAsync?(plainText: string): Promise<{ result: Buffer } | Buffer>;
  decryptStringAsync?(cipherText: Buffer): Promise<{ result: string } | string>;
}

/** The encrypted credential file's shape. */
interface CredentialFile {
  /** The version of the file format. */
  readonly version: 1;
  /** The provider the credential belongs to. */
  readonly providerId: string;
  /** The base64 ciphertext. */
  readonly ciphertext: string;
  /** When the credential was stored, in Unix ms. */
  readonly savedAt: number;
}

/** The encrypted credential file as it is written. */
interface CredentialDocument {
  readonly version: 1;
  readonly credentials: readonly CredentialFile[];
}

/**
 * The credential store.
 *
 * One instance per application; it owns the encrypted file and answers
 * "which key does this provider have?".
 */
export class CredentialService {
  readonly #path: string;
  readonly #safeStorage: SafeStorageLike | undefined;
  /** The resolved keys, in memory only. */
  readonly #cache = new Map<string, string>();

  constructor(options: { path: string; safeStorage?: SafeStorageLike }) {
    this.#path = options.path;
    this.#safeStorage = options.safeStorage;
  }

  /** The providers that have a stored key. */
  providers(): string[] {
    return [...this.#cache.keys()];
  }

  /** The key for a provider, when there is one. */
  get(providerId: string): string | undefined {
    return this.#cache.get(providerId);
  }

  /**
   * Load the encrypted file and decrypt every credential it holds.
   *
   * A file that cannot be decrypted — because the OS key store changed, or
   * because the file was tampered with — is reported rather than silently
   * ignored: the user must know their key is gone.
   */
  async load(): Promise<{ loaded: string[]; failed: string[] }> {
    const loaded: string[] = [];
    const failed: string[] = [];
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === 'ENOENT') return { loaded, failed };
      throw error;
    }

    let file: CredentialDocument;
    try {
      file = JSON.parse(raw) as CredentialDocument;
    } catch {
      // A corrupt file must not stop the app from starting.
      return { loaded, failed };
    }

    const entries = Array.isArray(file.credentials) ? file.credentials : [];

    for (const entry of entries) {
      if (!entry || typeof entry.providerId !== 'string') continue;
      try {
        const plain = await this.#decrypt(entry.ciphertext);
        this.#cache.set(entry.providerId, plain);
        loaded.push(entry.providerId);
      } catch {
        failed.push(entry.providerId);
      }
    }
    return { loaded, failed };
  }

  /**
   * Store a key for a provider.
   *
   * The plaintext never leaves this function: it is encrypted immediately and
   * only the ciphertext is written.
   */
  async save(providerId: string, apiKey: string): Promise<void> {
    const safeStorage = this.#safeStorage;
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'This system has no OS-backed encryption, so a key cannot be stored safely.',
      );
    }
    const ciphertext = await this.#encrypt(apiKey);
    this.#cache.set(providerId, apiKey);
    await this.#write([
      {
        version: 1,
        providerId,
        ciphertext: ciphertext.toString('base64'),
        savedAt: Date.now(),
      },
    ]);
  }

  /** Forget a provider's key. */
  async remove(providerId: string): Promise<void> {
    this.#cache.delete(providerId);
    const remaining = await this.#readAll();
    await this.#write(
      remaining.filter((entry) => entry.providerId !== providerId),
    );
  }

  /**
   * The key for a provider, for the backend's runtime.
   *
   * This is the only path a key takes out of the service: the backend asks
   * for it and puts it into Pi's in-memory credential store.
   */
  resolve(providerId: string): string | undefined {
    return this.#cache.get(providerId);
  }

  /** Encrypt with the async API when it exists, and the sync one otherwise. */
  async #encrypt(plainText: string): Promise<Buffer> {
    const safeStorage = this.#safeStorage!;
    if (typeof safeStorage.encryptStringAsync === 'function') {
      const result = await safeStorage.encryptStringAsync(plainText);
      // Electron 45 returns an object with `result`; older shapes returned the
      // buffer directly.
      if (result && typeof result === 'object' && 'result' in result) {
        return (result as { result: Buffer }).result;
      }
      return result as Buffer;
    }
    return safeStorage.encryptString(plainText);
  }

  /** Decrypt with the async API when it exists, and the sync one otherwise. */
  async #decrypt(cipherTextBase64: string): Promise<string> {
    const safeStorage = this.#safeStorage!;
    const buffer = Buffer.from(cipherTextBase64, 'base64');
    if (typeof safeStorage.decryptStringAsync === 'function') {
      const result = await safeStorage.decryptStringAsync(buffer);
      // Electron 45 returns an object with `result`; older shapes returned the
      // plaintext directly.
      if (result && typeof result === 'object' && 'result' in result) {
        return (result as { result: string }).result;
      }
      return result as string;
    }
    return safeStorage.decryptString(buffer);
  }

  /** Every credential in the file. */
  async #readAll(): Promise<CredentialFile[]> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      const parsed = JSON.parse(raw) as CredentialDocument;
      return Array.isArray(parsed.credentials) ? [...parsed.credentials] : [];
    } catch {
      return [];
    }
  }

  /** Write the credential file atomically. */
  async #write(entries: CredentialFile[]): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const document = { version: 1, credentials: entries };
    const temporary = `${this.#path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(document, null, 2), 'utf8');
      await rename(temporary, this.#path);
    } catch (error) {
      await writeFile(temporary, '', 'utf8').catch(() => {});
      throw error;
    }
  }
}

/** The `code` of a Node system error, when it has one. */
function errorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
