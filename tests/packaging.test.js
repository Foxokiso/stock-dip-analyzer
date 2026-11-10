import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Installing on Windows is one step: download one exe and run it. That holds only while
// the file keeps one name in every version (GitHub serves releases/latest/download/<name>
// for an exact name), the README links to that name, both workflows build and publish it,
// and the installer stays a one-click, per-user one. These are plain text files that drift
// apart silently, so they are read here.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const { build } = JSON.parse(read('package.json'));
const INSTALLER = 'stock-dip-analyzer-x64-setup.exe';
const DOWNLOAD = `https://github.com/Foxokiso/stock-dip-analyzer/releases/latest/download/${INSTALLER}`;

test('the Windows installer has one name in every version', () => {
    const { artifactName } = build.nsis;
    assert.doesNotMatch(artifactName, /\$\{(?:version|buildVersion|buildNumber)\}/, 'a version in the name would break the latest-download link');
    assert.equal(artifactName.replace('${arch}', 'x64').replace('${ext}', 'exe'), INSTALLER);
});

test('running the installer is the whole installation', () => {
    assert.equal(build.win.target, 'nsis');
    // One click: no wizard and no choices. Per user: no administrator prompt. Then the app opens.
    assert.equal(build.nsis.oneClick, true);
    assert.equal(build.nsis.perMachine, false);
    assert.equal(build.nsis.runAfterFinish, true);
});

test('the README downloads that exe directly, and names no other Windows file', () => {
    const readme = read('README.md');
    for (const heading of ['## Download', '## Install']) {
        const section = readme.slice(readme.indexOf(`\n${heading}\n`)).split(/\n## /)[1];
        assert.ok(section.includes(`](${DOWNLOAD})`), `${heading} links to the installer itself`);
    }
    const named = [...readme.matchAll(/[\w.<>${}-]+\.exe\b/g)].map(match => match[0]);
    assert.deepEqual([...new Set(named)], [INSTALLER]);
});

test('both workflows build the installer under the name package.json gives it', () => {
    for (const workflow of ['.github/workflows/windows-installer.yml', '.github/workflows/release.yml']) {
        const text = read(workflow);
        assert.doesNotMatch(text, /-c\.nsis\.artifactName/, `${workflow} must not rename the installer`);
        assert.ok(text.includes(`release/${INSTALLER}`), `${workflow} looks for ${INSTALLER}`);
        assert.doesNotMatch(text, /stock-dip-analyzer-[^\s'"`]*setup\.exe\.blockmap/, `${workflow} hands over the installer alone`);
        assert.doesNotMatch(text, /stock-dip-analyzer-(?!x64-setup\.exe)[^\s'"`]*setup\.exe/, `${workflow} names no other installer`);
    }
});

test('the release publishes exactly one Windows file, and its notes say to run it', () => {
    const release = read('.github/workflows/release.yml');
    const files = /files=\(\n([\s\S]*?)\n\s*\)/.exec(release)[1].split('\n').map(line => line.trim().replace(/^"|"$/g, ''));
    assert.deepEqual(files, [INSTALLER, 'stock-dip-analyzer-${version}-amd64.deb', 'stock-dip-analyzer-${version}-x86_64.AppImage']);
    assert.match(release, new RegExp(`\\*\\*Windows x64:\\*\\* download \\\\\`${INSTALLER.replaceAll('.', '\\.')}\\\\\` and run it\\.`));
});

test('the pull-request workflow installs with the one exe and opens the installed app', () => {
    const workflow = read('.github/workflows/windows-installer.yml');
    const step = workflow.slice(workflow.indexOf('- name: Install with the one exe and open the installed app'));
    assert.ok(step.length > 0 && step.length < workflow.length, 'the step exists');
    assert.match(step, /Start-Process -FilePath \$installer -ArgumentList '\/S' -Wait -PassThru/);
    assert.match(step, /if \(\$setup\.ExitCode -ne 0\) \{ throw/);
    assert.match(step, /if \(-not \$app\) \{ throw/);
    assert.match(step, /if \(-not \$opened\) \{ throw/);
    assert.doesNotMatch(step, /continue-on-error/);
});
