// @ts-check
/**
 * Electron's extension to `process`, in a utility process.
 *
 * Electron adds `process.parentPort` to the processes it forks: it is the
 * private channel between the utility process and the browser process that
 * forked it. The Node type definitions do not know about it, so it is
 * declared here.
 *
 * The declaration is global, because `process` is global — the module exists
 * only to carry the declaration.
 */
declare global {
  namespace NodeJS {
    interface Process {
      /**
       * The channel to the process that forked this one.
       *
       * It is present in an Electron utility process and absent everywhere
       * else, so it is always read defensively.
       */
      parentPort?: {
        postMessage(message: unknown): void;
        on(event: 'message', listener: (message: unknown) => void): void;
        start?(): void;
      };
    }
  }
}

export {};
