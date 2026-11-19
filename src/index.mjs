// 门面：跨目录（test/、bin/）只从这里 import 本插件，不直接摸 src/ 里的零件。
export { main } from './main.mjs'
export { DESCRIBE, describeLine } from './describe.mjs'
export {
  DEFAULT_BASE,
  DEFAULT_NAMESPACE,
  DOC_SPECS,
  dataHomeOf,
  fail,
  findOnPath,
  requireToken,
  resolveAgentMan,
  resolveConfig,
} from './config.mjs'
export { docUrlOf, createApi } from './api.mjs'
export { renderMemory, renderSituation, situationCore, stampOf } from './render.mjs'
export { emptyState, hashOf, loadState, saveState, statePath } from './state.mjs'
export {
  agentManVersion,
  agoOf,
  agoPhrase,
  buildDocs,
  collectSources,
  missingTocDocs,
  runAgentMan,
  senseLine,
  statusJson,
  statusView,
  syncRun,
  tocNodesOf,
} from './sync.mjs'