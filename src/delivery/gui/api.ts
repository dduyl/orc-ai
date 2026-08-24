/**
 * The preload-exposed electron API, in its own module so view components can
 * import it without reaching back into the renderer entrypoint (which imports
 * those views — an ESM cycle when the dependency is reversed).
 */
export const api = window.electronAPI;
