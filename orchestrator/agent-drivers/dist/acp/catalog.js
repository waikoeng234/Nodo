// ACP engines advertise their model catalog as session config options, where the
// thinking-level option is rebuilt for whichever model is selected. A scan
// therefore selects every candidate in turn inside one throwaway session and
// reads the levels off each recomputed option set.
const choicesOf = option => (Array.isArray(option?.options) ? option.options : [])
    .flatMap(item => (Array.isArray(item?.options) ? item.options : [item]));
// The thinking levels of one model: `efforts` are {id, name} pairs and `preferred`
// the level the engine would pick on its own, which is only a default when the
// model actually lists it.
export const levelsOf = (efforts, preferred) => {
    const thinking = (efforts ?? []).flatMap((effort) => {
        const id = effort?.id === undefined || effort.id === null ? '' : String(effort.id);
        return id === '' ? [] : [{ id, ...(effort.name ? { label: String(effort.name) } : {}) }];
    });
    const wanted = preferred === undefined || preferred === null ? '' : String(preferred);
    return { ...(thinking.length ? { thinking } : {}), ...(thinking.some(level => level.id === wanted) ? { defaultThinking: wanted } : {}) };
};
const levelsFromOptions = (configOptions, effortConfigId) => {
    const option = (configOptions ?? []).find(item => item.id === effortConfigId);
    return levelsOf(choicesOf(option).filter(level => typeof level?.value === 'string' && level.value !== '')
        .map(level => ({ id: level.value, name: level.name })), option?.currentValue);
};
// A choice outside a nested group may carry its provider in the value, the way
// OpenCode lists every model as `<provider>/<model>`: that provider is the
// section the model sits under, and a name repeating it drops the route prefix.
// A choice under a nested group already names its own section.
const sectionOf = (value, name, group) => {
    const at = value.indexOf('/');
    const provider = at > 0 ? value.slice(0, at) : '';
    const label = provider !== '' && name.startsWith(`${provider}/`) ? name.slice(provider.length + 1) : name;
    const section = group ?? provider;
    return { ...(label !== '' ? { label } : {}), ...(section ? { group: String(section) } : {}) };
};
// One model entry per choice of the model option; selecting a candidate makes
// the reply carry the complete recomputed option set, whose effort option names
// that model's levels. A candidate that cannot be selected keeps no levels.
export async function acpModelCatalog({ peer, sessionId, configOptions, modelConfigId = 'model', effortConfigId }) {
    const modelOption = (configOptions ?? []).find(option => option.id === modelConfigId);
    const models = [];
    const seen = new Set();
    for (const item of Array.isArray(modelOption?.options) ? modelOption.options : []) {
        const group = Array.isArray(item?.options) ? item.name ?? item.group : undefined;
        for (const choice of Array.isArray(item?.options) ? item.options : [item]) {
            if (typeof choice?.value !== 'string' || choice.value === '' || seen.has(choice.value))
                continue;
            seen.add(choice.value);
            let current = configOptions;
            if (choice.value !== modelOption.currentValue) {
                try {
                    current = (await peer.request('session/set_config_option', { sessionId, configId: modelConfigId, value: choice.value })).configOptions;
                }
                catch {
                    current = undefined;
                }
            }
            models.push({ id: choice.value, ...sectionOf(choice.value, String(choice.name ?? ''), group), ...(current ? levelsFromOptions(current, effortConfigId) : {}) });
        }
    }
    return models;
}
