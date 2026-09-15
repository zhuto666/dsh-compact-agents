/**
 * 自检：插件模块能被导入，且 `defineTool` 接受本插件的参数/输出规格。
 * 不加载 DSH 运行时，只用假的 ctx 走一遍 apply。
 *
 * 运行：node scripts/selftest.mjs
 */
import { name, inject, apply } from '../index.js'

const registered = []
apply({ tools: { register: definition => { registered.push(definition) } } })

if (registered.length !== 1) throw new Error(`expected 1 tool registration, got ${registered.length}`)
const tool = registered[0]

if (tool.name !== 'compact_agents') throw new Error(`unexpected tool name: ${tool.name}`)
if (typeof tool.output?.schema !== 'object') throw new Error('missing output schema')
if (typeof tool.output?.render !== 'function') throw new Error('missing output render')
if (typeof tool.execute !== 'function') throw new Error('missing execute')

console.log('module name  :', name)
console.log('inject       :', inject.join(', '))
console.log('tool name    :', tool.name)
console.log('timeoutMs    :', tool.timeoutMs)
console.log('description  :', tool.description.length, 'chars')
console.log('parameters   :', Object.keys(tool.parameters.properties).join(', '))
console.log('scopes       :', tool.parameters.properties.scope.enum.join(', '))
console.log('whenBusy     :', tool.parameters.properties.whenBusy.enum.join(', '))
console.log('outputSchema :', typeof tool.output.schema)
console.log('OK')
