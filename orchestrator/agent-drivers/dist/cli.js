import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export const invalidConfig = message => Object.assign(new Error(message), { code: 'orch/invalid' });
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
export function findExecutable(command, { path = process.env.PATH ?? '', home = homedir(), defaults = [join(home, '.local/bin'), '/usr/local/bin', '/opt/homebrew/bin'] } = {}) {
    const bin = validateBin(command);
    if (!bin)
        return undefined;
    const dirs = [...path.split(delimiter), ...defaults].filter(dir => isAbsolute(dir));
    const candidates = isAbsolute(bin) ? [bin] : [...new Set(dirs)].map(dir => join(dir, bin));
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
export async function cliVersion(bin, options = {}) {
    const { stdout } = await execute(bin, ['--version'], { ...options, ...(options.env ? { env: { ...process.env, ...options.env } } : {}), timeout: 5000, maxBuffer: 16_384, windowsHide: true });
    return stdout.trim().split('\n')[0].slice(0, 120);
}
