import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, manualClock } from './helpers/mainProcess.js';

// The application menu main.cjs sets once the app is ready: a Go menu with a shortcut
// per desk, standard Edit and View menus, and developer tools only in development.

function start(options = {}) {
    const main = loadMain(undefined, manualClock(Date.UTC(2026, 10, 2)), options);
    main.ready();
    const menu = main.electron.Menu.applicationMenu?.template;
    const find = label => menu.find(item => item.label === label);
    return { ...main, menu, find, appContents: main.windows[0].webContents };
}
const allItems = items => items.flatMap(item => [item, ...allItems(item.submenu ?? [])]);
// main.cjs runs in a VM, so its objects come from another realm; compare plain copies.
const plain = value => JSON.parse(JSON.stringify(value));

test('the menu is set before the window opens and has File, Edit, Go, View, Window and Help on Windows and Linux', () => {
    for (const platform of ['linux', 'win32']) {
        const { menu } = start({ platform, dirname: platform === 'win32' ? 'C:\\Program Files\\DDS response\\resources\\app.asar' : undefined });
        assert.deepEqual(plain(menu.map(item => item.label ?? item.role)), ['File', 'editMenu', 'Go', 'View', 'windowMenu', 'Help'], platform);
        assert.deepEqual(plain(menu[0].submenu.map(item => item.role)), ['quit']);
    }
    const mac = start({ platform: 'darwin' }).menu;
    assert.equal(mac[0].role, 'appMenu');
    assert.deepEqual(plain(mac[1].submenu.map(item => item.role)), ['close']);
});

test('Go opens each desk in navigation-bar order, with Ctrl/Cmd+1-5 and Ctrl/Cmd+, for Settings', () => {
    const { find } = start();
    const desks = find('Go').submenu.filter(item => item.click && item.accelerator?.startsWith('CmdOrCtrl'));
    assert.deepEqual(plain(desks.map(item => [item.label, item.accelerator])), [
        ['Overview', 'CmdOrCtrl+1'],
        ['Futures', 'CmdOrCtrl+2'],
        ['ETF rankings', 'CmdOrCtrl+3'],
        ['Oil Watch', 'CmdOrCtrl+4'],
        ['Discovery', 'CmdOrCtrl+5'],
        ['Settings', 'CmdOrCtrl+,'],
    ]);
});

test('a Go item changes the hash route in the app window, and only there; Back and Forward walk its history', () => {
    const { find, appContents } = start();
    const go = Object.fromEntries(find('Go').submenu.filter(item => item.label).map(item => [item.label, item]));
    go.Futures.click();
    go.Overview.click();
    go.Settings.click();
    go.Back.click();
    go.Forward.click();
    assert.deepEqual(appContents.executed, [
        'location.hash = "#/futures"',
        'location.hash = "#/"',
        'location.hash = "#/settings"',
        'history.back()',
        'history.forward()',
    ]);
    assert.equal(go.Back.accelerator, 'Alt+Left');
    assert.equal(go.Forward.accelerator, 'Alt+Right');
});

test('a Go item after the window has closed does nothing', () => {
    const main = start();
    const futures = main.find('Go').submenu.find(item => item.label === 'Futures');
    main.windows[0].close();
    assert.doesNotThrow(() => futures.click());
});

test('developer tools are in the menu only in development, not in the installed app', () => {
    const roles = main => allItems(main.menu).map(item => item.role).filter(Boolean);
    const installed = roles(start({ packaged: true }));
    assert.ok(!installed.includes('toggleDevTools') && !installed.includes('forceReload'), 'no developer tools in a packaged build');
    assert.ok(installed.includes('reload') && installed.includes('togglefullscreen') && installed.includes('zoomIn'));
    const dev = roles(start({ packaged: false }));
    assert.ok(dev.includes('toggleDevTools') && dev.includes('forceReload'));
});

test('Help opens the project page in the system browser and offers About with the app name and version', () => {
    const main = start();
    const help = main.find('Help');
    help.submenu.find(item => item.label === 'Project page').click();
    assert.deepEqual(main.opened, ['https://github.com/Foxokiso/stock-dip-analyzer']);
    assert.ok(help.submenu.some(item => item.role === 'about'));
    assert.deepEqual(plain(main.electron.app.aboutPanelOptions), { applicationName: 'DDS response', applicationVersion: '9.9.9', website: 'https://github.com/Foxokiso/stock-dip-analyzer' });
});
