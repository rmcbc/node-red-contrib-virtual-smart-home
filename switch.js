const baseNode = require('./baseNode')
const { powerState } = require('./validators')

module.exports = function (RED) {
  function SwitchNode (config) {
    baseNode({
      RED,
      config,
      node: this,
      template: 'SWITCH',
      defaultState: {
        source: 'device',
        powerState: 'OFF'
      },
      validators: {
        powerState
      }
    })
  }

  RED.nodes.registerType('vsh-switch', SwitchNode)
}
