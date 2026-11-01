/**
 * The app's own strings.
 *
 * The file is plain JavaScript — the app's window is served over HTTP as a
 * static file and the app has no bundler. This declaration gives the
 * TypeScript side of the project the same information.
 */
export interface StringTable {
  readonly [key: string]: string;
}

declare const strings: {
  readonly en: StringTable;
  readonly zh: StringTable;
};

export default strings;
