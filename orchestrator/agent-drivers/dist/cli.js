import { accessSync, constants, statSync } from 'node:fs';
import { extname, isAbsolute, join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export const invalidConfig = (message) => Object.assign(new Error(message), { code: 'orch/invalid' });
export function validateWorkspace(cwd, required = false) {
    if (cwd === undefined || cwd === null || cwd === '') {
        if (required)
            throw invalidConfig('Choose an absolute working directory for this engine');
        return undefined;
    }
    if (typeof cwd !== 'string' || !isAbsolute(cwd))
        throw invalidConfig('Working directory must be an absolute path');
    try {
        if (!statSync(cwd).isDirectory())
            throw new Error('not a directory');
    }
    catch {
        throw invalidConfig(`The working directory "${cwd}" does not exist`);
    }
    return cwd;
}
export function validateBin(bin) {
    if (bin === undefined || bin === null || bin === '')
        return undefined;
    if (typeof bin !== 'string' || bin.length > 1000 || bin.includes('\0'))
        throw invalidConfig('Invalid CLI executable');
    const clean = bin.trim();
    if (!isAbsolute(clean) && !/^[\w.-]+$/.test(clean))
        throw invalidConfig('CLI executable must be an absolute path or a command name');
    return clean || undefined;
}
// Windows resolves bare command names through PATHEXT, so a `claude` on PATH is
// really claude.exe or claude.cmd. npm also leaves an extensionless sh shim in the
// same directory that cannot be spawned, so the bare name is probed last.
const windowsExtensions = ['.exe', '.cmd', '.bat'];
export function findExecutable(command, { path = process.env.PATH ?? '', home = homedir(), platform = process.platform, defaults = [join(home, '.local/bin'), ...(platform === 'win32' ? [] : ['/usr/local/bin', '/opt/homebrew/bin'])], extra = [] } = {}) {
    const bin = validateBin(command);
    if (!bin)
        return undefined;
    const dirs = [...path.split(delimiter), ...defaults, ...extra].filter(dir => isAbsolute(dir));
    const names = platform === 'win32' && extname(bin) === '' ? [...windowsExtensions.map(extension => bin + extension), bin] : [bin];
    const candidates = isAbsolute(bin) ? names : [...new Set(dirs)].flatMap(dir => names.map(name => join(dir, name)));
    return candidates.find(candidate => {
        try {
            accessSync(candidate, constants.X_OK);
            return statSync(candidate).isFile();
        }
        catch {
            return false;
        }
    });
}
// Desktop apps registered for uninstall expose their install dir even when they
// never touch PATH, so an installer may have put them on any drive or folder.
const uninstallRoots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];
// The first absolute Windows path in a registry value: quoted for uninstall
// strings, whole for display icons, which may carry a ",0" icon index.
const registryPath = (value) => {
    const quoted = value.match(/"([^"]+)"/);
    const text = (quoted ? quoted[1] : value.split(',')[0]).trim();
    return /^[A-Za-z]:\\.+/.test(text) ? text : '';
};
export function registryProgramDirs(match, { platform = process.platform, query } = {}) {
    if (platform !== 'win32')
        return [];
    const run = query ?? ((root, text) => {
        try {
            return execFileSync('reg', ['query', root, '/s', '/f', text, '/d'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
        }
        catch {
            return '';
        }
    });
    const dirs = new Set();
    let location = '', uninstall = '', icon = '';
    const flush = () => {
        // InstallLocation already names the directory; uninstall and icon values name
        // files inside their directory, cut at the last backslash — never path.dirname,
        // which only sees separators of the running platform.
        const file = registryPath(uninstall) || registryPath(icon);
        const cut = file.lastIndexOf('\\');
        const value = (location || (cut >= 0 ? file.slice(0, cut) : '')).replace(/\\+$/, '');
        if (value)
            dirs.add(value);
        location = uninstall = icon = '';
    };
    for (const root of uninstallRoots) {
        for (const line of run(root, match).split(/\r?\n/)) {
            if (/^HKEY_/i.test(line)) {
                flush();
                continue;
            }
            const at = line.indexOf('REG_SZ');
            if (at < 0)
                continue;
            const name = line.slice(0, at).trim(), data = line.slice(at + 6).trim();
            if (!data)
                continue;
            if (name === 'InstallLocation')
                location = data;
            else if (name === 'UninstallString')
                uninstall = data;
            else if (name === 'DisplayIcon')
                icon = data;
        }
        flush();
    }
    return [...dirs];
}
// Node refuses to spawn .cmd/.bat shims directly (CVE-2024-27980); route them
// through cmd.exe with the command quoted. An argument is quoted when it
// contains whitespace, so an argument value must not contain double quotes.
export function launchCommand(bin, args = [], { platform = process.platform } = {}) {
    if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin))
        return { bin, args };
    return { bin: 'cmd.exe', args: ['/d', '/s', '/c', [`"${bin}"`, ...args.map(arg => /\s/.test(arg) ? `"${arg}"` : arg)].join(' ')], verbatim: true };
}
export async function cliVersion(bin, options = {}) {
    const { args, ...rest } = options;
    const launch = launchCommand(bin, args ?? ['--version']);
    const { stdout } = await execute(launch.bin, launch.args, {
        ...rest, ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
        ...(rest.env ? { env: { ...process.env, ...rest.env } } : {}), timeout: 5000, maxBuffer: 16_384, windowsHide: true,
    });
    return stdout.trim().split('\n')[0].slice(0, 120);
}
