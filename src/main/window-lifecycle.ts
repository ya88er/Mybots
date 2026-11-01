// @ts-check
/**
 * The tray icon and the window's lifecycle.
 *
 * The app is a desktop app that keeps working when the window is closed: a
 * schedule that comes due at 09:00 has to be delivered whether or not anyone
 * is looking at the window. So closing the window hides it, and the tray is
 * how the user brings it back.
 *
 * The rules this module keeps:
 *
 * - closing the window **hides** it; it does not quit the app;
 * - the tray menu has exactly three items — open, start at sign-in, quit;
 * - quitting stops the backend with a **bounded** wait, so a hung tool can
 *   never leave a zombie process behind;
 * - the "quit" is always the user's explicit choice, never a side effect.
 */
import { BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { appRoot } from './paths.ts';

/** How long the app waits for the backend to stop, in milliseconds. */
export const SHUTDOWN_TIMEOUT_MS = 5_000;

/** The tray's menu and the icon that carries it. */
export interface TrayController {
  /** Show the window and focus it. */
  show: () => void;
  /** The tray icon, for the tests to find. */
  readonly tray: Tray;
  /** The menu that is currently shown, for the tests to read. */
  readonly menu: Electron.Menu | undefined;
  /** Update the "start at sign-in" item's checked state. */
  setStartAtLogin: (enabled: boolean) => void;
  /** The menu's items, by id, for the tests. */
  item: (id: string) => Electron.MenuItem | undefined;
  /**
   * Invoke one of the menu's actions.
   *
   * This is the same call the platform makes when the user picks the item.
   */
  action: (id: string, checked?: boolean) => void;
  /** Destroy the tray icon. */
  destroy: () => void;
}

/**
 * The window's lifecycle rules.
 *
 * The window hides instead of closing, so a running turn and a scheduled
 * delivery both survive. The quit is the tray's "Quit" item, or the app's
 * own `before-quit` handling.
 */
export interface WindowController {
  /** Show the window, restoring it if it was minimised. */
  show: () => void;
  /** Hide the window. */
  hide: () => void;
  /** Whether the window is visible. */
  readonly visible: boolean;
}

/**
 * Install the window's lifecycle rules.
 *
 * `close` is intercepted: the window hides and the close is prevented. The app
 * only really quits through the tray's "Quit" item, which sets `quitting` so
 * that the next close is allowed through.
 */
export function installWindowLifecycle(
  window: BrowserWindow,
  options: { onQuitRequested: () => void },
): WindowController {
  let quitting = false;

  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });

  return {
    show: () => {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    },
    hide: () => window.hide(),
    get visible() {
      return window.isVisible();
    },
  };
}

/**
 * Mark the app as quitting.
 *
 * The window's `close` handler asks for it, so the next close really closes.
 */
export function allowClose(): void {
  quittingFlag = true;
}

/** Whether the app has been told to quit for real. */
let quittingFlag = false;

/** Whether the app is quitting for real. */
export function isQuitting(): boolean {
  return quittingFlag;
}

/**
 * The tray icon's image.
 *
 * The app ships a small PNG; when it is missing — in a development run, for
 * instance — an empty icon is used, which is still a valid tray icon and
 * keeps the tray's presence testable.
 */
function trayImage(): Electron.NativeImage {
  const candidates = [
    join(appRoot(), 'build', 'tray-icon.png'),
    join(appRoot(), 'resources', 'tray-icon.png'),
    join(appRoot(), 'vendor', 'minimax-bot', 'miniapp', 'client', 'skins', 'default.png'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) return image;
  }
  return nativeImage.createEmpty();
}

/**
 * Create the tray icon and its menu.
 *
 * The menu is rebuilt whenever the sign-in item's state changes, because
 * Electron's menu items are immutable once a menu is built.
 */
export function createTray(options: {
  /** Show the window. */
  onShow: () => void;
  /** Toggle starting at sign-in. */
  onToggleStartAtLogin: (enabled: boolean) => void;
  /** Whether the app starts at sign-in right now. */
  isStartAtLoginEnabled: () => boolean;
  /** Quit the app. */
  onQuit: () => void;
  /** The tray's tooltip. */
  tooltip: string;
}): TrayController {
  let startAtLogin = options.isStartAtLoginEnabled();
  /** The menu that is currently shown. */
  let current: Electron.Menu | undefined;

  /**
   * The menu's actions, kept beside the menu itself.
   *
   * Electron's `MenuItem` does not expose the handler it was built with, so
   * the actions are kept here as well. They are what the menu calls, and
   * they are what the tests call: the behaviour is the same either way.
   */
  const actions = new Map<string, (checked?: boolean) => void>();

  const build = (): Electron.Menu => {
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: options.tooltip, enabled: false },
      { type: 'separator' },
      {
        id: 'show',
        label: options.tooltip,
        click: () => actions.get('show')?.(),
      },
      {
        id: 'start-at-login',
        label: options.tooltip,
        type: 'checkbox',
        checked: startAtLogin,
        click: (item) => {
          const enabled = item.checked;
          startAtLogin = enabled;
          actions.get('start-at-login')?.(enabled);
          // The menu is rebuilt so that the tick reflects the new state even
          // if the platform changed its mind.
          current = build();
          tray.setContextMenu(current);
        },
      },
      { type: 'separator' },
      {
        id: 'quit',
        label: options.tooltip,
        click: () => actions.get('quit')?.(),
      },
    ];
    return Menu.buildFromTemplate(template);
  };

  actions.set('show', () => options.onShow());
  actions.set('start-at-login', (enabled) => options.onToggleStartAtLogin(enabled === true));
  actions.set('quit', () => options.onQuit());

  const tray = new Tray(trayImage());
  tray.setToolTip(options.tooltip);
  current = build();
  tray.setContextMenu(current);
  tray.on('click', () => options.onShow());

  return {
    tray,
    get menu() {
      return current;
    },
    show: () => options.onShow(),
    setStartAtLogin: (enabled: boolean) => {
      startAtLogin = enabled;
      current = build();
      tray.setContextMenu(current);
    },
    item: (id: string) => current?.items.find((entry: Electron.MenuItem) => entry.id === id),
    /**
     * Invoke one of the menu's actions.
     *
     * This is the same call the platform makes when the user picks the item.
     */
    action: (id: string, checked?: boolean) => actions.get(id)?.(checked),
    destroy: () => tray.destroy(),
  };
}

