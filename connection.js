const { Base64 } = require('js-base64')
const debounce = require('debounce')
const semver = require('semver')
const fetch = require('node-fetch')
const MqttClient = require('./MqttClient')
const RateLimiter = require('./RateLimiter')
const VSH_VERSION = require('./version')
const {
  buildNewStateForDirectiveRequest,
  buildPropertiesFromState,
  annotateChanges,
} = require('./directives')

module.exports = function (RED) {
  function ConnectionNode(config) {
    RED.nodes.createNode(this, config)

    const node = this

    this.logger = config.debug
      ? (logMessage, variable = undefined, logLevel = 'log') => {
          //logLevel: log | warn | error | trace | debug
          if (variable) {
            logMessage = logMessage + ': ' + JSON.stringify(variable)
          }
          this[logLevel](logMessage)
        }
      : (logMessage, variable) => {}

    this.rater = new RateLimiter(
      [
        { period: 1 * 60 * 1000, limit: 12, penalty: 0, repeat: 10 }, //for 10 min: Limit to 12 req / min
        { period: 10 * 60 * 1000, limit: 5, penalty: 1 }, //afterward: Limit to 5 req / 10 min
      ],
      null, //= callback
      this.logger
    )

    this.mqttClient = undefined
    this.childNodes = {}
    this.isConnected = false
    this.isDisconnecting = false
    this.isSubscribed = false
    this.isError = false
    this.isKilled = false
    this.killedStatusText = 'KILLED'
    this.allowedDeviceCount = 200
    this.userIdToken = ''

    this.stats = {
      lastStartup: new Date().getTime(),
      connectionCount: 0,
      inboundMsgCount: 0,
      outboundMsgCount: 0,
    }

    this.jobQueue = []

    this.jobQueueExecutor = setInterval(() => {
      this.jobQueue = this.jobQueue.filter((job) => job() == false)
    }, 1000)

    this.execOrQueueJob = function (job) {
      if (job() == false) {
        this.jobQueue.push(job)
      }
    }

    this.registerChildNode = function (nodeId, callbacks) {
      // console.log(
      //   `registerChildNode() for ${nodeId} | allowed: ${this.allowedDeviceCount}`
      // )

      if (Object.keys(this.childNodes).length >= this.allowedDeviceCount) {
        callbacks.setStatus({
          shape: 'dot',
          fill: 'gray',
          text: 'device limit reached!',
        })
        return
      }

      this.childNodes[nodeId] = callbacks

      if (Object.keys(this.childNodes).length == 1) {
        //first child node is registering!
        //console.log('first child node registering!!!')

        this.connectAndSubscribe()
      }

      //immediately push most relevant state to new subscriber
      this.execCallbackForOne(nodeId, 'setStatus', {
        shape: 'dot',
        fill: this.isConnected ? 'green' : 'red',
        text: this.isConnected ? 'online' : 'offline',
      })

      const requestConfigJob = () => {
        if (!this.isSubscribed) {
          return false
        }

        this.requestConfigDebounced()
      }

      this.execOrQueueJob(requestConfigJob)
    }

    this.unregisterChildNode = async function (nodeId) {
      //console.log(`unregisterChildNode() for ${nodeId}`)
      delete this.childNodes[nodeId]

      if (Object.keys(this.childNodes).length == 0) {
        //last child node is unregistering!
        await this.disconnect()
      }
    }

    this.getLocalDevices = function () {
      const localDevices = {}

      for (const nodeId in this.childNodes) {
        localDevices[nodeId] = this.childNodes[nodeId].getDeviceConfig()
      }

      return localDevices
    }

    this.execCallbackForAll = function (eventName, eventDetails) {
      const result = {}
      for (const nodeId in this.childNodes) {
        if (this.childNodes[nodeId][eventName]) {
          result[nodeId] = this.childNodes[nodeId][eventName](eventDetails)
        }
      }
      return result
    }

    this.execCallbackForOne = function (nodeId, eventName, eventDetails) {
      if (this.childNodes[nodeId][eventName]) {
        return this.childNodes[nodeId][eventName](eventDetails)
      }
    }

    this.requestConfig = function () {
      this.publish(`vsh/${this.credentials.thingId}/requestConfig`, {
        vshVersion: VSH_VERSION,
      })
    }

    this.publish = async function (topic, message) {
      if (!this.mqttClient) {
        return
      }

      this.stats.outboundMsgCount++

      this.logger(`MQTT publish to topic ${topic}`, message)

      return await this.mqttClient.publish(topic, message)
    }

    this.requestConfigDebounced = debounce(this.requestConfig, 1000)

    this.triggerChangeReport = function ({
      endpointId,
      properties,
      causeType,
      correlationToken = '',
      useRateLimiter,
    }) {
      const changes = properties.filter((prop) => prop.changed).length

      if (changes == 0 && causeType == 'PHYSICAL_INTERACTION') {
        this.logger(`skipping ChangeReport - no properties changed`)
        return
      }

      const publishCb = () => {
        if (!this.isDisconnecting) {
          this.publish(`vsh/${this.credentials.thingId}/changeReport`, {
            endpointId,
            properties,
            correlationToken,
            causeType,
            vshVersion: VSH_VERSION,
            userIdToken: this.userIdToken,
          })
        }
      }

      if (useRateLimiter) {
        this.rater.execute(`${endpointId}`, publishCb.bind(this))
      } else {
        publishCb()
      }
    }

    this.bulkDiscover = function (devices, mode = 'discover') {
      const payload = { devices: [] }

      for (const deviceId in devices) {
        if (devices[deviceId] !== null) {
          payload['devices'].push({
            deviceId,
            friendlyName: devices[deviceId]['friendlyName'],
            template: devices[deviceId]['template'],
          })
        }
      }

      if (payload.devices.length > 0) {
        this.publish(`vsh/${this.credentials.thingId}/bulk${mode}`, payload)
      }
    }

    this.handleGetAccepted = function (message) {
      const localDevices = this.getLocalDevices()
      const shadowDevices =
        (message.state.reported && message.state.reported.devices) || {}

      const toBeDiscoveredDevices = {}

      for (const deviceId in localDevices) {
        if (
          !shadowDevices.hasOwnProperty(deviceId) ||
          shadowDevices[deviceId]['template'] !==
            localDevices[deviceId]['template'] ||
          shadowDevices[deviceId]['friendlyName'] !==
            localDevices[deviceId]['friendlyName']
        ) {
          toBeDiscoveredDevices[deviceId] = localDevices[deviceId]
        }
      }

      const toBeUndiscoveredDevices = {}

      for (const deviceId in shadowDevices) {
        if (!localDevices.hasOwnProperty(deviceId)) {
          toBeUndiscoveredDevices[deviceId] = shadowDevices[deviceId]
          toBeDiscoveredDevices[deviceId] = null
        }
      }

      if (Object.keys(toBeDiscoveredDevices).length > 0) {
        this.publish(`$aws/things/${this.credentials.thingId}/shadow/update`, {
          state: { reported: { devices: toBeDiscoveredDevices } },
        })

        this.bulkDiscover(toBeDiscoveredDevices)
      }

      this.bulkDiscover(toBeUndiscoveredDevices, 'undiscover')
    }

    this.handleLocalDeviceStateChange = function ({
      deviceId,
      oldState,
      newState,
    }) {
      const oldProperties = buildPropertiesFromState(oldState)
      let newProperties = buildPropertiesFromState(newState)

      // annotate whether properties changed or not
      newProperties = annotateChanges(newProperties, oldProperties)

      // tell Alexa about new device properties
      this.triggerChangeReport({
        endpointId: deviceId,
        properties: newProperties,
        causeType: 'PHYSICAL_INTERACTION',
        useRateLimiter: true,
      })
    }

    this.handleReportState = function (deviceId, directiveRequest) {
      // EXAMPLE directiveRequest:
      // {
      //   directive: {
      //     header: {
      //       namespace: 'Alexa',
      //       name: 'ReportState',
      //       payloadVersion: '3',
      //       correlationToken: 'AAAAAAAAAQAwOfXmbhm...',
      //     },
      //     endpoint: {
      //       endpointId: 'vshd-xxxxxxxxxxxxx',
      //     },
      //     payload: {},
      //   },
      // }

      const currentState = this.execCallbackForOne(deviceId, 'getLocalState')

      if (!currentState) {
        this.logger(
          `no local state found for device ID ${deviceId}`,
          null,
          'warn'
        )
        return
      }

      const currentProperties = buildPropertiesFromState(currentState).map(
        (prop) => {
          prop['changed'] = false
          return prop
        }
      )

      this.triggerChangeReport({
        endpointId: deviceId,
        properties: currentProperties,
        causeType: 'STATE_REPORT',
        correlationToken: directiveRequest.directive.header.correlationToken,
        useRateLimiter: false,
      })
    }

    this.handleDirectiveFromAlexa = function (deviceId, directiveRequest) {
      // EXAMPLE directiveRequest:
      // {
      //   directive: {
      //     header: {
      //       namespace: 'Alexa.PowerController',
      //       name: 'TurnOn',
      //       payloadVersion: '3',
      //       correlationToken: 'AAAAAAAAAQAwOfXmbhm...',
      //     },
      //     endpoint: {
      //       endpointId: 'vshd-xxxxxxxxxxxxx',
      //     },
      //     payload: {},
      //   },
      // }

      // get current device state
      const oldState = this.execCallbackForOne(deviceId, 'getLocalState')

      if (!oldState) {
        this.logger(
          `no local state found for device ID ${deviceId}`,
          null,
          'warn'
        )
        return
      }

      // memorize old properties so that we can find out what changed
      const oldProperties = buildPropertiesFromState(oldState)

      // apply directive to local device state
      try {
        const newState = buildNewStateForDirectiveRequest(
          directiveRequest,
          oldState
        )

        // update local device state
        const newConfirmedState = this.execCallbackForOne(
          deviceId,
          'setLocalState',
          newState
        )

        // emit msg obj
        this.execCallbackForOne(deviceId, 'emitLocalState', {
          rawDirective: directiveRequest,
        })

        let newProperties = buildPropertiesFromState(newConfirmedState)

        // annotate whether properties changed or not
        newProperties = annotateChanges(newProperties, oldProperties)

        // tell Alexa about new device properties
        this.triggerChangeReport({
          endpointId: deviceId,
          properties: newProperties,
          causeType: 'VOICE_INTERACTION',
          correlationToken: directiveRequest.directive.header.correlationToken,
          useRateLimiter: false,
        })
      } catch (e) {
        this.logger(e.message, null, 'error')
        return
      }
    }

    this.handlePing = function ({ semverExpr }) {
      if (!semver.satisfies(VSH_VERSION, semverExpr)) {
        return
      }

      this.publish(`vsh/${this.credentials.thingId}/pong`, {
        thingId: this.credentials.thingId,
        email: this.credentials.email,
        vsh_version: VSH_VERSION,
        nr_version: RED.version(),
        secondsSinceStartup: Math.floor(
          (new Date().getTime() - this.stats.lastStartup) / 1000
        ),
        ...this.stats,
        deviceCount: Object.keys(this.childNodes).length,
        devices: this.execCallbackForAll('getDeviceConfig'),
      })
    }

    this.handleKill = function ({ reason, semverExpr }) {
      if (semverExpr && !semver.satisfies(VSH_VERSION, semverExpr)) {
        return
      }

      console.warn('CONNECTION KILLED! Reason:', reason || 'undefined')
      this.isKilled = true
      this.killedStatusText = reason ? reason : 'KILLED'
      this.disconnect()
    }

    this.handleSetDeviceStatus = function ({ status, color, devices }) {
      devices.forEach((deviceId) => {
        this.execCallbackForOne(deviceId, 'setStatus', {
          shape: 'dot',
          fill: color,
          text: status,
        })
      })
    }

    this.handleService = function (message) {
      switch (message.operation) {
        case 'ping':
          this.handlePing(message)
          break
        case 'overrideConfig':
          this.publish(`$aws/things/${this.credentials.thingId}/shadow/get`, {})

          if (message.rateLimiter) {
            const iterations = message.rateLimiter
            this.rater.overrideConfig(iterations)
          }
          if (message.userIdToken) {
            this.userIdToken = message.userIdToken
          }
          if (message.allowedDeviceCount) {
            this.allowedDeviceCount = message.allowedDeviceCount
            this.unrigisterUnallowedDevices(message.allowedDeviceCount)
          }
          break
        case 'kill':
          this.handleKill(message)
          break
        case 'setDeviceStatus':
          this.handleSetDeviceStatus(message)
          break
        default:
          this.logger(
            `received service request (${message.operation}) that is not supported by this VSH version. Updating to the latest version might fix this!`,
            'warn'
          )
      }
    }

    this.checkVersion = async function () {
      const response = await fetch(
        `${
          config.backendUrl
        }/check_version?version=${VSH_VERSION}&nr_version=${RED.version()}&thingId=${
          this.credentials.thingId
        }`
      )

      // EXAMPLE
      // {
      //   "isAllowedVersion": false,
      //   "isLatestVersion": false,
      //   "updateHint": "Please update to the latest version of VSH!",
      //   "allowedDeviceCount": 5,
      // }
      if (!response.ok) {
        throw new Error(
          `HTTP Error Response: ${response.status} ${response.statusText}`
        )
      }
      return await response.json()
    }

    this.unrigisterUnallowedDevices = function (allowedDeviceCount) {
      let i = 0

      for (const nodeId in this.childNodes) {
        i++
        if (i > allowedDeviceCount) {
          this.execCallbackForOne(nodeId, 'setStatus', {
            shape: 'dot',
            fill: 'gray',
            text: 'device limit reached!',
          })
          this.unregisterChildNode(nodeId)
        }
      }
    }

    this.connectAndSubscribe = async function () {
      if (!this.credentials.server) {
        return
      }

      try {
        const { isAllowedVersion, isLatestVersion, updateHint } =
          await this.checkVersion()

        if (!isLatestVersion) {
          this.logger(
            `A newer version of VSH is available! Your system might no longer work as expected`,
            null,
            'warn'
          )
        }

        if (!isAllowedVersion) {
          this.logger(
            `connection to backend refused: ${updateHint}`,
            null,
            'error'
          )
          this.execCallbackForAll('setStatus', {
            shape: 'dot',
            fill: 'gray',
            text: updateHint,
          })
          return
        }
      } catch (e) {
        return this.logger(`version check failed! ${e.message}`, null, 'error')
      }

      this.isDisconnecting = false

      const options = {
        host: this.credentials.server,
        port: config.port,
        key: Base64.decode(this.credentials.privateKey),
        cert: Base64.decode(this.credentials.cert),
        ca: Base64.decode(this.credentials.caCert),
        clientId: this.credentials.thingId,
        reconnectPeriod: 5000,
        keepalive: 90,
        rejectUnauthorized: false,
        will: {
          topic: `vsh/${this.credentials.thingId}/update`,
          payload: JSON.stringify({
            state: { reported: { connected: false } },
          }),
          qos: 1,
        },
      }

      this.mqttClient = new MqttClient(options, {
        onConnect: () => {
          this.logger(`MQTT connecting to ${options.host}:${options.port}`)
          this.stats.connectionCount++
          this.isConnected = true
          this.isError = false
          this.execCallbackForAll('setStatus', {
            shape: 'dot',
            fill: 'green',
            text: 'online',
          })

          this.publish(
            `$aws/things/${this.credentials.thingId}/shadow/update`,
            {
              state: {
                reported: {
                  connected: true,
                  vsh_version: VSH_VERSION,
                  nr_version: RED.version(),
                },
              },
            }
          )
        },

        onDisconnect: () => {
          this.logger('MQTT disconnected')
          this.isConnected = false
          if (!this.isError) {
            this.execCallbackForAll('setStatus', {
              shape: 'dot',
              fill: 'red',
              text: this.isKilled ? this.killedStatusText : 'offline',
            })
          }
        },

        onError: (error) => {
          this.isConnected = false
          this.isError = true
          this.execCallbackForAll('setStatus', {
            shape: 'dot',
            fill: 'red',
            text: error.code,
          })
        },

        onSubscribeSuccess: (subscribeResult) => {
          this.isSubscribed = true
        },

        onMessage: (topic, message) => {
          this.logger(`MQTT message received on topic ${topic}`, message)
          this.stats.inboundMsgCount++
          switch (topic) {
            case `$aws/things/${this.credentials.thingId}/shadow/get/accepted`:
              this.handleGetAccepted(message)
              break
            case `vsh/service`:
            case `vsh/version/${VSH_VERSION}/service`:
            case `vsh/${this.credentials.thingId}/service`:
              this.handleService(message)
              break
            default:
              const match = topic.match(/vshd-[^\/]+/)
              if (match) {
                const deviceId = match[0]

                if (topic.includes('/directive')) {
                  if (message.directive.header.name == 'ReportState') {
                    this.handleReportState(deviceId, message)
                  } else {
                    this.handleDirectiveFromAlexa(deviceId, message)
                  }
                } else {
                  this.logger(
                    'received device-related message that is not supported yet!',
                    { topic, message },
                    null,
                    'warn'
                  )
                }
              } else {
                this.logger(
                  'received thing-related message that is not supported yet!',
                  { topic, message },
                  null,
                  'warn'
                )
              }
          }
        },
      })

      this.logger(
        `Attempting MQTT connection: ${options.host}:${options.port} (clientId: ${options.clientId})`
      )
      this.mqttClient.connect()

      const topicsToSubscribe = [
        `$aws/things/${this.credentials.thingId}/shadow/get/accepted`,
        `vsh/${this.credentials.thingId}/+/directive`,
        `vsh/service`,
        `vsh/version/${VSH_VERSION}/+`,
        `vsh/${this.credentials.thingId}/service`,
      ]

      this.logger('MQTT subscribe to topics', topicsToSubscribe)

      await this.mqttClient.subscribe(topicsToSubscribe)
    }

    this.disconnect = async function () {
      if (!this.isConnected || this.isDisconnecting) {
        return
      }

      this.logger('MQTT disconnecting')

      this.isDisconnecting = true

      await this.publish(
        `$aws/things/${this.credentials.thingId}/shadow/update`,
        {
          state: { reported: { connected: false } },
        }
      )

      if (this.mqttClient) {
        await this.mqttClient.disconnect()
      }

      this.isSubscribed = false
    }

    this.on('close', async function (removed, done) {
      this.rater.destroy()

      if (!this.credentials.thingId) {
        return done()
      }

      clearInterval(this.jobQueueExecutor)
      try {
        await this.disconnect()
      } catch (e) {
        console.log('connection.js:this:on:close::', e)
      }

      this.execCallbackForAll('onDisconnect')
      done()
    })
  }

  RED.nodes.registerType('vsh-connection', ConnectionNode, {
    credentials: {
      refreshToken: { type: 'text' },
      accessToken: { type: 'text' },
      email: { type: 'text' },
      cert: { type: 'text' },
      thingId: { type: 'text' },
      caCert: { type: 'text' },
      server: { type: 'text' },
      privateKey: { type: 'text' },
    },
    settings: {
      vshConnectionShowSettings: {
        //= RED.settings.vshConnectionShowSettings
        value: false,
        exportable: true,
      },
    },
  })
}
