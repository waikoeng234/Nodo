// Shared inventory for the composer's /-menu: markdown skill and prompt files
// found by scanning each engine's documented global locations. There is no
// protocol listing, so `source` names what answered and an empty scan stays an
// honest empty list.
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
const frontmatter = (path) => {
    let head;
    try {
        head = readFileSync(path, 'utf8').slice(0, 4096);
    }
    catch {
        return {};
    }
    const body = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)?.[1] ?? '';
    const line = (key) => new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(body)?.[1]?.trim();
    return { name: line('name'), description: line('description') };
};
// The subdirectories of one directory, [] when it is missing; the shared shape
// behind the plugin-cache walks (every engine caches one dir per version). A
// symlink counts as its target: skill trees are commonly linked across engines.
export const listDirs = (dir) => {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter(entry => { try {
            return statSync(join(dir, entry.name)).isDirectory();
        }
        catch {
            return false;
        } })
            .map(entry => join(dir, entry.name));
    }
    catch {
        return [];
    }
};
// The plain files of one directory, [] when it is missing; the flat-markdown
// shape next to the directory bundles above.
export const listFiles = (dir) => {
    try {
        return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(dir, entry.name));
    }
    catch {
        return [];
    }
};
// One collector per scan: the id rules and dedupe the claude scan established,
// shared so every engine's menu behaves alike. Each entry keeps where it lives
// (`path`, realpath-resolved so a symlinked skill lists once) and who answers
// for it (`scope`, `origin`) — what the UI labels and a merged view would group by.
export const COMMAND_NAME = /^[A-Za-z0-9][\w:.-]{0,99}$/;
export const collector = () => {
    const found = new Map();
    const seen = new Set();
    return {
        add(path, id, owner, scope = 'global') {
            let at = path;
            try {
                at = realpathSync(path);
            }
            catch { /* vanished mid-scan */ }
            if (seen.has(at))
                return;
            const meta = frontmatter(path);
            const name = String(path.endsWith('SKILL.md') ? meta.name ?? id : id).trim();
            const full = owner !== undefined ? `${owner}:${name}` : name;
            if (!COMMAND_NAME.test(full) || found.has(full))
                return;
            seen.add(at);
            found.set(full, {
                id: full,
                ...(meta.description ? { description: meta.description.slice(0, 200) } : {}),
                path: at,
                scope,
                origin: owner ?? scope,
            });
        },
        list: source => ({ source, commands: [...found.values()].slice(0, 200) }),
    };
};
