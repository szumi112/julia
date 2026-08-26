export const appModeFrom = (mode) => mode === 'demo' ? 'demo' : 'app'
export const basePathFor = (mode) => appModeFrom(mode) === 'demo' ? '/julia/' : '/'
export const appSurfaceFor = (mode) => appModeFrom(mode) === 'demo' ? 'demo' : 'protected'
export const APP_MODE = appModeFrom(import.meta.env?.MODE)
